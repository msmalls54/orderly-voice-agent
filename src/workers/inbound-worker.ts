import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { safeError } from "../logger.js";
import type { MessageHandler } from "../types.js";
import { SmsStore } from "../store/store.js";

export class InboundWorker {
  constructor(
    private readonly store: SmsStore,
    private readonly handler: MessageHandler,
    private readonly config: AppConfig,
    private readonly logger: AppLogger
  ) {}

  async runOnce(): Promise<boolean> {
    const job = this.store.claimInbound(this.config.ADMIN_PHONE);
    if (!job) return false;
    const idempotencyKey = `agentphone:${job.deliveryId}`;
    let nonIdempotentActionStarted = false;
    try {
      const command = job.body.normalize("NFKC").trim().toUpperCase();
      if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(command)) {
        this.store.setOptedOut(job.sender, true);
        this.store.completeInboundWithReply(job, "Orderly: You are unsubscribed and will receive no more messages. Reply START to resume.", "compliance_reply");
        return true;
      }
      if (["START", "UNSTOP"].includes(command)) {
        this.store.setOptedOut(job.sender, false);
        this.store.completeInboundWithReply(job, "Orderly: Messages have resumed. Reply STOP to unsubscribe.", "compliance_reply");
        return true;
      }
      if (command === "HELP") {
        this.store.completeInboundWithReply(job, "Orderly help: this is a supervised demo. Reply STOP to unsubscribe.", "compliance_reply");
        return true;
      }
      if (this.store.isOptedOut(job.sender)) {
        this.store.completeInboundSilently(job);
        return true;
      }
      if (this.handler.retrySafety === "unknown") {
        // Persist the attempt before any handler-controlled external effect.
        // A crash after this point becomes an ambiguity hold, never a replay.
        this.store.beginInboundAction(job, idempotencyKey);
        nonIdempotentActionStarted = true;
      }
      const reply = await this.handler.handle({
        deliveryId: job.deliveryId,
        idempotencyKey,
        sender: job.sender,
        body: job.body
      });
      if (reply.length < 1 || reply.length > this.config.MAX_SMS_LENGTH) {
        throw Object.assign(new Error("Handler returned an invalid SMS length"), { code: "INVALID_HANDLER_REPLY" });
      }
      if (nonIdempotentActionStarted) {
        this.store.completeInboundActionWithReply(job, idempotencyKey, reply);
      } else {
        this.store.completeInboundWithReply(job, reply);
      }
      this.logger.info({ event: "sms.inbound_processed", deliveryId: job.deliveryId }, "Inbound SMS processed");
    } catch (error) {
      const safe = safeError(error);
      let outcome: "retried" | "failed" | "ambiguous";
      if (nonIdempotentActionStarted) {
        this.store.failInboundActionAmbiguous(job, idempotencyKey, safe.code, this.config.ADMIN_PHONE);
        outcome = "ambiguous";
      } else {
        outcome = this.store.failOrRetryInbound(
          job,
          safe.code,
          this.handler.retrySafety === "idempotent" ? this.config.MAX_INBOUND_ATTEMPTS : 1,
          this.config.ADMIN_PHONE
        );
      }
      this.logger.error({ event: "sms.inbound_processing_failed", deliveryId: job.deliveryId, outcome, error: safe }, "Inbound SMS processing failed");
    }
    return true;
  }
}
