import crypto from "node:crypto";
import { AgentPhoneWebhookHeadersSchema } from "./schemas.js";

export interface AgentPhoneHeaderInput {
  signature: string | undefined;
  timestamp: string | undefined;
  webhookId: string | undefined;
  event: string | undefined;
}

export type VerificationResult =
  | { ok: true; webhookId: string; timestampSeconds: number }
  | { ok: false; reason: "INVALID_HEADERS" | "STALE_TIMESTAMP" | "INVALID_SIGNATURE" };

export function verifyAgentPhoneWebhook(
  rawBody: Buffer,
  input: AgentPhoneHeaderInput,
  secret: string,
  maxAgeSeconds = 300,
  nowMs = Date.now()
): VerificationResult {
  const parsed = AgentPhoneWebhookHeadersSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_HEADERS" };

  const timestampSeconds = Number(parsed.data.timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowMs / 1000 - timestampSeconds) > maxAgeSeconds) {
    return { ok: false, reason: "STALE_TIMESTAMP" };
  }

  const digest = crypto.createHmac("sha256", secret)
    .update(`${parsed.data.timestamp}.`, "utf8")
    .update(rawBody)
    .digest("hex");
  const expected = Buffer.from(`sha256=${digest}`, "utf8");
  const received = Buffer.from(parsed.data.signature.toLowerCase(), "utf8");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }
  return { ok: true, webhookId: parsed.data.webhookId, timestampSeconds };
}

export function signAgentPhoneWebhook(rawBody: Buffer, timestamp: string, secret: string): string {
  const digest = crypto.createHmac("sha256", secret).update(`${timestamp}.`, "utf8").update(rawBody).digest("hex");
  return `sha256=${digest}`;
}

