import { z } from "zod";
import { E164_PATTERN } from "../types.js";

const Identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const NullableUrl = z.url().nullable();
const ProviderNumber = (schema: z.ZodNumber) => z.preprocess(
  (value) => typeof value === "string" && value.trim() !== "" ? Number(value) : value,
  schema
);
const ProviderPhone = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().replace(/^tel:/i, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return trimmed;
}, z.string().regex(E164_PATTERN));
const OptionalProviderIdentifier = z.preprocess(
  (value) => value === null || value === undefined || value === "None" || value === "" ? undefined : value,
  Identifier.optional()
);
const OptionalProviderConfidence = z.preprocess((value) => {
  if (value === null || value === undefined || value === "None" || value === "") return undefined;
  return typeof value === "string" ? Number(value) : value;
}, z.number().finite().min(0).max(1).optional());
const OptionalProviderDuration = z.preprocess((value) => {
  if (value === null || value === undefined || value === "None" || value === "") return undefined;
  return typeof value === "string" ? Number(value) : value;
}, z.number().finite().nonnegative().max(86_400).optional());

export const AgentPhoneWebhookHeadersSchema = z.object({
  signature: z.string().regex(/^sha256=[a-f0-9]{64}$/i),
  timestamp: z.string().regex(/^\d{10}$/),
  webhookId: Identifier,
  event: z.string().min(1).max(100).regex(/^[a-z._]+$/)
}).strict();

export const AgentPhoneWebhookEnvelopeSchema = z.object({
  event: z.string().min(1).max(100),
  channel: z.string().min(1).max(40),
  agentId: Identifier
}).passthrough();

const HistoryItemSchema = z.object({
  content: z.string().max(1600),
  direction: z.enum(["inbound", "outbound"]),
  channel: z.enum(["sms", "mms", "imessage", "voice"]),
  at: z.iso.datetime({ offset: true })
}).strict();

export const AgentPhoneTextMessageEventSchema = z.object({
  event: z.literal("agent.message"),
  channel: z.enum(["sms", "mms", "imessage"]),
  timestamp: z.iso.datetime({ offset: true }),
  agentId: Identifier,
  data: z.object({
    conversationId: Identifier,
    numberId: Identifier,
    from: z.string().regex(E164_PATTERN),
    to: z.string().regex(E164_PATTERN),
    message: z.string().max(1600),
    mediaUrl: NullableUrl.optional(),
    direction: z.literal("inbound"),
    receivedAt: z.iso.datetime({ offset: true }),
    senderIdentifier: z.string().max(200).optional(),
    group: z.object({ isGroup: z.literal(true) }).passthrough().optional()
  }).strict(),
  conversationState: z.record(z.string(), z.json()).nullable().optional(),
  recentHistory: z.array(HistoryItemSchema.extend({ senderIdentifier: z.string().max(200).optional() })).max(50).optional()
}).strict();

export type AgentPhoneTextMessageEvent = z.infer<typeof AgentPhoneTextMessageEventSchema>;

export const AgentPhoneVoiceMessageEventSchema = z.object({
  event: z.literal("agent.message"),
  channel: z.literal("voice"),
  timestamp: z.iso.datetime({ offset: true }),
  agentId: Identifier,
  data: z.object({
    callId: OptionalProviderIdentifier,
    numberId: Identifier,
    from: ProviderPhone,
    to: ProviderPhone,
    status: z.string().min(1).max(80),
    // AgentPhone's live beta can emit a signed voice turn with an empty
    // transcript when no speech was recognized. Treat it as an empty turn;
    // the coordinator will ask the caller to repeat instead of returning 400.
    transcript: z.string().max(4000),
    confidence: OptionalProviderConfidence,
    direction: z.literal("inbound")
  }).passthrough(),
  conversationState: z.record(z.string(), z.json()).nullable().optional(),
  // The live beta currently uses provider-specific role/channel labels and
  // timestamps here. We do not consume history for authorization or order
  // state, so constrain its shape and size without coupling voice turns to it.
  recentHistory: z.array(z.record(z.string(), z.unknown())).max(50).optional()
}).passthrough();

export type AgentPhoneVoiceMessageEvent = z.infer<typeof AgentPhoneVoiceMessageEventSchema>;

export const AgentPhoneCallEndedEventSchema = z.object({
  event: z.literal("agent.call_ended"),
  channel: z.literal("voice"),
  timestamp: z.iso.datetime({ offset: true }),
  agentId: Identifier,
  data: z.object({
    callId: Identifier,
    numberId: Identifier,
    from: z.string().regex(E164_PATTERN),
    to: z.string().regex(E164_PATTERN),
    direction: z.enum(["inbound", "outbound", "web"]),
    status: z.string().min(1).max(80),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    // This is non-authoritative telemetry. The beta has returned fractional
    // numeric strings and "None", neither of which should reject call cleanup.
    durationSeconds: OptionalProviderDuration,
    disconnectionReason: z.string().max(120).nullable().optional(),
    transcript: z.array(z.object({
      role: z.enum(["agent", "user"]),
      content: z.string().max(4000)
    }).passthrough()).max(200),
    summary: z.string().max(4000).nullable().optional(),
    userSentiment: z.string().max(80).nullable().optional(),
    callSuccessful: z.boolean().nullable().optional()
  }).passthrough()
}).passthrough();

export const AgentPhoneSendResponseSchema = z.object({
  id: Identifier,
  status: z.string().min(1).max(80),
  channel: z.string().min(1).max(40).optional()
}).passthrough();

export const AgentPhoneWebhookResponseSchema = z.object({
  id: Identifier,
  url: z.url(),
  secret: z.string().min(16),
  status: z.string().min(1).max(80),
  contextLimit: z.number().int().min(0).max(50),
  timeout: z.number().int().min(5).max(120),
  createdAt: z.iso.datetime({ offset: true })
}).passthrough();

export const AgentPhoneErrorResponseSchema = z.union([
  z.object({
    error: z.object({
      code: z.string().min(1).max(100).optional(),
      message: z.string().max(1000).optional(),
      type: z.string().max(100).optional()
    }).passthrough()
  }).passthrough(),
  z.object({ detail: z.string().max(1000) }).passthrough()
]);
