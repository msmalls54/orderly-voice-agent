import type { AppConfig } from "../config.js";
import type { OutboundMessage, ProviderReceipt, SmsProvider } from "../types.js";
import { E164_PATTERN, SmsProviderError } from "../types.js";
import {
  AgentPhoneErrorResponseSchema,
  AgentPhoneSendResponseSchema,
  AgentPhoneWebhookResponseSchema
} from "./schemas.js";

type RequestFunction = (input: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

const NON_RETRIABLE_429 = new Set([
  "CONVERSATION_STREAK_LIMIT",
  "CONVERSATION_AWAITING_REPLY",
  "CONVERSATION_INACTIVE",
  "OUTBOUND_LIMIT_REACHED",
  "NEW_CONVERSATION_LIMIT_REACHED"
]);

export class AgentPhoneSmsProvider implements SmsProvider {
  readonly name = "agentphone" as const;
  private readonly allowedDestinations: ReadonlySet<string>;

  constructor(
    private readonly config: AppConfig,
    private readonly request: RequestFunction = fetch
  ) {
    this.allowedDestinations = new Set([...config.ALLOWED_PHONES, config.ADMIN_PHONE]);
  }

  async send(message: OutboundMessage): Promise<ProviderReceipt> {
    if (!this.config.LIVE_SMS_ENABLED) {
      throw new SmsProviderError("Live SMS is disabled", "LIVE_SMS_DISABLED", false, false);
    }
    if (!E164_PATTERN.test(message.to) || !this.allowedDestinations.has(message.to)) {
      throw new SmsProviderError("Destination is not authorized", "DESTINATION_FORBIDDEN", false, false);
    }
    if (message.body.length < 1 || message.body.length > this.config.MAX_SMS_LENGTH) {
      throw new SmsProviderError("Message length is invalid", "MESSAGE_LENGTH_INVALID", false, false);
    }

    let response: Response;
    try {
      response = await this.request(`${this.config.AGENTPHONE_API_BASE_URL}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.AGENTPHONE_API_KEY!}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          agent_id: this.config.AGENTPHONE_AGENT_ID!,
          to_number: message.to,
          body: message.body
        }),
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new SmsProviderError("AgentPhone send result is unknown", "TRANSPORT_OUTCOME_UNKNOWN", false, true);
    }

    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw classifyAgentPhoneError(response, payload);
    const parsed = AgentPhoneSendResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new SmsProviderError("AgentPhone returned an unknown receipt", "RECEIPT_SCHEMA_MISMATCH", false, true);
    }
    return {
      providerMessageId: parsed.data.id,
      providerStatus: parsed.data.status,
      ...(parsed.data.channel ? { channel: parsed.data.channel } : {})
    };
  }

  async inspectIsolatedWebhook(): Promise<{
    webhookId: string;
    url: string;
    status: string;
    contextLimit: number;
    timeout: number;
  } | null> {
    if (!this.config.AGENTPHONE_API_KEY || !this.config.AGENTPHONE_AGENT_ID) {
      throw new SmsProviderError("AgentPhone inspection credentials are missing", "INSPECTION_NOT_CONFIGURED", false, false);
    }
    const response = await this.request(
      `${this.config.AGENTPHONE_API_BASE_URL}/agents/${encodeURIComponent(this.config.AGENTPHONE_AGENT_ID)}/webhook`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${this.config.AGENTPHONE_API_KEY}` },
        signal: AbortSignal.timeout(15_000)
      }
    );
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw classifyAgentPhoneError(response, payload);
    if (payload === null) return null;
    const parsed = AgentPhoneWebhookResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new SmsProviderError("AgentPhone returned an invalid webhook record", "WEBHOOK_RECEIPT_INVALID", false, false);
    }
    return {
      webhookId: parsed.data.id,
      url: parsed.data.url,
      status: parsed.data.status,
      contextLimit: parsed.data.contextLimit,
      timeout: parsed.data.timeout
    };
  }

  async configureIsolatedWebhook(
    expectedCurrentWebhookId: string | null,
    persistSecret: (secret: string) => Promise<void>
  ): Promise<{ webhookId: string; status: string }> {
    if (!this.config.AGENTPHONE_WEBHOOK_SETUP_ENABLED || !this.config.AGENTPHONE_AGENT_SEPARATION_CONFIRMED) {
      throw new SmsProviderError("Webhook setup is disabled", "WEBHOOK_SETUP_DISABLED", false, false);
    }
    const current = await this.inspectIsolatedWebhook();
    if ((current?.webhookId ?? null) !== expectedCurrentWebhookId) {
      throw new SmsProviderError("Webhook changed since operator review", "WEBHOOK_CHANGED_SINCE_REVIEW", false, false);
    }
    const webhookUrl = `${this.config.PUBLIC_WEBHOOK_URL!.replace(/\/$/, "")}/sms`;
    const response = await this.request(
      `${this.config.AGENTPHONE_API_BASE_URL}/agents/${encodeURIComponent(this.config.AGENTPHONE_AGENT_ID!)}/webhook`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.AGENTPHONE_API_KEY!}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ url: webhookUrl, contextLimit: 0, timeout: 30 }),
        signal: AbortSignal.timeout(15_000)
      }
    );
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw classifyAgentPhoneError(response, payload);
    const parsed = AgentPhoneWebhookResponseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.url !== webhookUrl) {
      throw new SmsProviderError("AgentPhone returned an invalid webhook receipt", "WEBHOOK_RECEIPT_INVALID", false, true);
    }
    await persistSecret(parsed.data.secret);
    return { webhookId: parsed.data.id, status: parsed.data.status };
  }
}

function classifyAgentPhoneError(response: Response, payload: unknown): SmsProviderError {
  const parsed = AgentPhoneErrorResponseSchema.safeParse(payload);
  const errorEnvelope = parsed.success && "error" in parsed.data && typeof parsed.data.error === "object" && parsed.data.error !== null
    ? parsed.data.error as { code?: unknown }
    : undefined;
  const rawCode = typeof errorEnvelope?.code === "string" ? errorEnvelope.code : undefined;
  const code = rawCode && /^[A-Z0-9_]{1,100}$/.test(rawCode) ? rawCode : `HTTP_${response.status}`;

  if (response.status === 429) {
    const retryAfter = boundedRetryAfter(response.headers.get("retry-after"));
    const retryable = !NON_RETRIABLE_429.has(code) && (code === "RATE_LIMITED" || retryAfter !== undefined);
    return new SmsProviderError("AgentPhone rate limit", code, retryable, false, retryAfter);
  }
  if (response.status === 408 || response.status >= 500) {
    // AgentPhone publishes no idempotency key for sends and warns that a 5xx
    // can occur after execution. Treat this as ambiguous, never as retryable.
    return new SmsProviderError("AgentPhone send result is unknown", code, false, true);
  }
  return new SmsProviderError("AgentPhone rejected the message", code, false, false);
}

function boundedRetryAfter(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? Math.max(1, Math.min(seconds, 300)) : undefined;
}
