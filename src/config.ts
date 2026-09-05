import path from "node:path";
import { z } from "zod";
import { E164_PATTERN } from "./types.js";

const boolFromEnv = (fallback: "true" | "false") =>
  z.enum(["true", "false"]).default(fallback).transform((value) => value === "true");

const optionalString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional()
);

const optionalUrl = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.url().optional()
);

const optionalIsoDateTime = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()).optional()
);

const phoneList = z.string().transform((value, ctx) => {
  const phones = [...new Set(value.split(",").map((phone) => phone.trim()).filter(Boolean))];
  if (phones.length === 0 || phones.some((phone) => !E164_PATTERN.test(phone))) {
    ctx.addIssue({ code: "custom", message: "ALLOWED_PHONES must contain one or more comma-separated E.164 numbers" });
    return z.NEVER;
  }
  return phones;
});

const base64Key = z.string().min(1).refine((value) => {
  try { return Buffer.from(value, "base64").length === 32; } catch { return false; }
}, "must be a base64-encoded 32-byte key");

const EnvSchema = z.object({
  SMS_PROVIDER: z.enum(["mock", "agentphone"]).default("mock"),
  APP_MODE: z.enum(["mock", "live_read_only", "live"]).default("mock"),
  LIVE_SMS_ENABLED: boolFromEnv("false"),
  SMS_OUTBOUND_VERIFIED: boolFromEnv("false"),
  VOICE_PURCHASE_VERIFIED: boolFromEnv("false"),
  AGENTPHONE_API_BASE_URL: z.url().default("https://api.agentphone.ai/v1"),
  AGENTPHONE_API_KEY: optionalString,
  AGENTPHONE_AGENT_ID: optionalString,
  AGENTPHONE_NUMBER_ID: optionalString,
  AGENTPHONE_PHONE_NUMBER: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().regex(E164_PATTERN).optional()
  ),
  AGENTPHONE_WEBHOOK_SECRET: optionalString,
  AGENTPHONE_WEBHOOK_SETUP_ENABLED: boolFromEnv("false"),
  AGENTPHONE_AGENT_SEPARATION_CONFIRMED: boolFromEnv("false"),
  AGENTPHONE_WEBHOOK_REMOTE_VERIFIED: boolFromEnv("false"),
  PUBLIC_WEBHOOK_URL: optionalUrl,
  ALLOWED_PHONES: phoneList,
  ADMIN_PHONE: z.string().regex(E164_PATTERN),
  DATA_ENCRYPTION_KEY: base64Key,
  PII_HASH_KEY: z.string().min(16),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_PATH: z.string().min(1).default("./data/orderly-sms.db"),
  WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(600).default(300),
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1024).max(131072).default(32768),
  MAX_SMS_LENGTH: z.coerce.number().int().min(1).max(1600).default(800),
  MAX_SMS_PER_10_MINUTES: z.coerce.number().int().min(1).max(100).default(12),
  MIN_VOICE_CONFIRMATION_CONFIDENCE: z.coerce.number().min(0).max(1).default(0),
  CHECKOUT_CONFIRM_TTL_SECONDS: z.coerce.number().int().min(30).max(300).default(180),
  ORDER_TOTAL_LIMIT_CENTS: z.coerce.number().int().min(100).max(100000).default(5000),
  PURCHASE_ENABLED: boolFromEnv("false"),
  DOORDASH_ACCOUNT_CONNECTED_VERIFIED: boolFromEnv("false"),
  DOORDASH_CLI_PATH: optionalString,
  DD_CLI_ACCESS_TOKEN: optionalString,
  DOORDASH_DEMO_CART_UUID: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/).optional()
  ),
  DOORDASH_SCHEDULED_TIME: optionalIsoDateTime,
  DOORDASH_PURCHASE_RUN_ID: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().uuid().optional()
  ),
  MAX_QUEUE_AGE_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
  MAX_INBOUND_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  MAX_OUTBOUND_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(2).default(1),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  ELEVENLABS_API_BASE_URL: z.url().default("https://api.elevenlabs.io"),
  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_AGENT_ID: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().regex(/^agent_[A-Za-z0-9]+$/).optional()
  ),
  VOICE_SESSION_LIMIT: z.coerce.number().int().min(1).max(60).default(6),
  VOICE_SESSION_WINDOW_SECONDS: z.coerce.number().int().min(60).max(3600).default(600)
}).passthrough().superRefine((env, ctx) => {
  if (!env.ALLOWED_PHONES.includes(env.ADMIN_PHONE)) {
    ctx.addIssue({ code: "custom", path: ["ADMIN_PHONE"], message: "ADMIN_PHONE must also appear in ALLOWED_PHONES" });
  }
  if (env.PURCHASE_ENABLED) {
    if (env.SMS_PROVIDER !== "agentphone") ctx.addIssue({ code: "custom", path: ["SMS_PROVIDER"], message: "Purchasing requires the live AgentPhone provider" });
    if (env.APP_MODE !== "live") ctx.addIssue({ code: "custom", path: ["APP_MODE"], message: "Purchasing requires APP_MODE=live" });
    if (!env.DOORDASH_ACCOUNT_CONNECTED_VERIFIED) ctx.addIssue({ code: "custom", path: ["DOORDASH_ACCOUNT_CONNECTED_VERIFIED"], message: "Purchasing requires a verified DoorDash connection" });
    if (!env.DOORDASH_CLI_PATH) ctx.addIssue({ code: "custom", path: ["DOORDASH_CLI_PATH"], message: "Purchasing requires the pinned DoorDash CLI" });
    if (!env.DD_CLI_ACCESS_TOKEN) ctx.addIssue({ code: "custom", path: ["DD_CLI_ACCESS_TOKEN"], message: "Purchasing requires the DoorDash access token" });
    if (!env.DOORDASH_DEMO_CART_UUID) ctx.addIssue({ code: "custom", path: ["DOORDASH_DEMO_CART_UUID"], message: "Purchasing requires the exact pre-staged and validated DoorDash cart" });
    if (!env.DOORDASH_PURCHASE_RUN_ID) ctx.addIssue({ code: "custom", path: ["DOORDASH_PURCHASE_RUN_ID"], message: "Purchasing requires a fresh immutable DoorDash purchase-run ID" });
    if (!env.VOICE_PURCHASE_VERIFIED && (!env.LIVE_SMS_ENABLED || !env.SMS_OUTBOUND_VERIFIED)) {
      ctx.addIssue({ code: "custom", path: ["PURCHASE_ENABLED"], message: "Purchasing requires either the verified voice checkout path or the verified SMS notification path" });
    }
  }
  if (env.SMS_PROVIDER !== "agentphone") return;
  for (const key of ["AGENTPHONE_AGENT_ID", "AGENTPHONE_WEBHOOK_SECRET"] as const) {
    if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required for the AgentPhone provider` });
  }
  if (!env.PUBLIC_WEBHOOK_URL?.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["PUBLIC_WEBHOOK_URL"], message: "AgentPhone requires a public HTTPS webhook URL" });
  }
  if (!env.AGENTPHONE_AGENT_SEPARATION_CONFIRMED) {
    ctx.addIssue({ code: "custom", path: ["AGENTPHONE_AGENT_SEPARATION_CONFIRMED"], message: "Confirm this is a new agent that does not serve Grandpa Food" });
  }
  if ((env.LIVE_SMS_ENABLED || env.AGENTPHONE_WEBHOOK_SETUP_ENABLED) && !env.AGENTPHONE_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["AGENTPHONE_API_KEY"], message: "The API key is required only for enabled outbound or deliberate webhook setup" });
  }
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(raw);
  return { ...parsed, DATABASE_PATH: path.resolve(parsed.DATABASE_PATH) };
}
