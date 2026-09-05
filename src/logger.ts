import pino from "pino";
import type { AppConfig } from "./config.js";

const REDACTION_PATHS = [
  "apiKey",
  "authorization",
  "secret",
  "webhookSecret",
  "req.headers.authorization",
  "req.headers.x-webhook-signature",
  "headers.authorization",
  "headers.x-webhook-signature",
  "rawBody",
  "body",
  "message"
];

export function createLogger(config: Pick<AppConfig, "LOG_LEVEL">) {
  return pino({
    level: config.LOG_LEVEL,
    redact: { paths: REDACTION_PATHS, censor: "[redacted]" },
    base: { service: "orderly-agentphone-sms" }
  });
}

export type AppLogger = ReturnType<typeof createLogger>;

export function redactPhone(phone: string): string {
  if (phone.length < 5) return "[redacted-phone]";
  return `${phone.slice(0, 2)}••••••${phone.slice(-2)}`;
}

export function safeError(error: unknown): { name: string; code: string } {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "UNEXPECTED_ERROR";
    return { name: error.name.slice(0, 80), code: code.slice(0, 80) };
  }
  return { name: "UnknownError", code: "UNEXPECTED_ERROR" };
}

