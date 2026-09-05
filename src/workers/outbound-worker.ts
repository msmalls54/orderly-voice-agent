import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { redactPhone, safeError } from "../logger.js";
import type { SmsProvider } from "../types.js";
import { E164_PATTERN, SmsProviderError } from "../types.js";
import { SmsStore } from "../store/store.js";

export class OutboundWorker {
  private readonly allowedDestinations: ReadonlySet<string>;

  constructor(
    private readonly store: SmsStore,
    private readonly provider: SmsProvider,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly retryDelay: (error: SmsProviderError, attempt: number) => number = defaultRetryDelay
  ) {
    this.allowedDestinations = new Set([...config.ALLOWED_PHONES, config.ADMIN_PHONE]);
  }

  async runOnce(): Promise<boolean> {
    const job = this.store.claimOutbound(this.config.ADMIN_PHONE);
    if (!job) return false;
    try {
      if (!E164_PATTERN.test(job.to) || !this.allowedDestinations.has(job.to)) {
        throw new SmsProviderError("Destination is not authorized", "DESTINATION_FORBIDDEN", false, false);
      }
      if (job.body.length < 1 || job.body.length > this.config.MAX_SMS_LENGTH) {
        throw new SmsProviderError("Message length is invalid", "MESSAGE_LENGTH_INVALID", false, false);
      }
      if (job.kind === "user_reply" && this.store.isOptedOut(job.to)) {
        this.store.cancelClaimedOutbound(job.id);
        this.logger.info({ event: "sms.outbound_cancelled", kind: job.kind, to: redactPhone(job.to) }, "Cancelled queued reply after opt-out");
        return true;
      }
      if (this.store.recentOutboundCount(job.to) > this.config.MAX_SMS_PER_10_MINUTES) {
        throw new SmsProviderError("Message frequency limit exceeded", "LOCAL_RATE_LIMIT", false, false);
      }
      const receipt = await this.provider.send(job);
      this.store.markOutboundAccepted(job.id, receipt.providerMessageId);
      this.logger.info({
        event: "sms.outbound_accepted",
        provider: this.provider.name,
        kind: job.kind,
        to: redactPhone(job.to),
        providerStatus: receipt.providerStatus,
        length: job.body.length
      }, "Outbound SMS accepted by provider");
    } catch (error) {
      const providerError = error instanceof SmsProviderError
        ? error
        : new SmsProviderError("Provider result is unknown", safeError(error).code, false, true);
      const outcome = this.store.failOrRetryOutbound(
        job,
        providerError,
        this.config.MAX_OUTBOUND_ATTEMPTS,
        this.config.ADMIN_PHONE,
        this.retryDelay(providerError, job.attempts)
      );
      this.logger.error({
        event: "sms.outbound_failed",
        provider: this.provider.name,
        kind: job.kind,
        to: redactPhone(job.to),
        attempt: job.attempts,
        outcome,
        error: safeError(providerError)
      }, "Outbound SMS was not confirmed accepted");
    }
    return true;
  }

  async runUntilIdle(maxJobs = 100): Promise<number> {
    let processed = 0;
    while (processed < maxJobs && await this.runOnce()) processed += 1;
    return processed;
  }
}

function defaultRetryDelay(error: SmsProviderError, attempt: number): number {
  if (error.retryAfterSeconds !== undefined) return error.retryAfterSeconds;
  return Math.min(300, 2 ** Math.min(attempt, 8));
}
