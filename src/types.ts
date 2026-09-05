export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export type OutboundKind = "user_reply" | "compliance_reply" | "admin_alert";
export type OutboundStatus = "queued" | "sending" | "accepted" | "failed" | "ambiguous" | "cancelled";
export type InboundStatus = "queued" | "processing" | "completed" | "failed";

export interface OutboundMessage {
  to: string;
  body: string;
  kind: OutboundKind;
}

export interface ProviderReceipt {
  providerMessageId: string;
  providerStatus: string;
  channel?: string;
}

export interface SmsProvider {
  readonly name: "agentphone" | "mock";
  send(message: OutboundMessage): Promise<ProviderReceipt>;
}

export class SmsProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly ambiguous: boolean,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "SmsProviderError";
  }
}

export interface InboundJob {
  deliveryId: string;
  sender: string;
  body: string;
  attempts: number;
}

export interface OutboundJob extends OutboundMessage {
  id: string;
  attempts: number;
}

export interface MessageHandler {
  readonly retrySafety: "idempotent" | "unknown";
  handle(message: {
    deliveryId: string;
    idempotencyKey: string;
    sender: string;
    body: string;
  }): Promise<string>;
}

export interface VoiceTurnResult {
  text: string;
  hangup?: boolean;
  followUpSms?: string;
}

export interface VoiceTurnHandler {
  handle(turn: {
    deliveryId: string;
    sender: string;
    transcript: string;
    callId: string;
  }): Promise<VoiceTurnResult>;
}

export interface QueueHealth {
  inboundQueued: number;
  inboundFailed: number;
  outboundQueued: number;
  outboundFailed: number;
  outboundAmbiguous: number;
  failedAdminAlerts: number;
  voiceProcessing: number;
  voiceFailed: number;
  orderSubmissionsOpen: number;
  orderSubmissionsAmbiguous: number;
  cartPreparationsActive: number;
  cartPreparationsUncertain: number;
  oldestInboundAgeSeconds: number | null;
  oldestOutboundAgeSeconds: number | null;
  oldestVoiceAgeSeconds: number | null;
  oldestOrderSubmissionAgeSeconds: number | null;
}

export interface WorkerHealth {
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
}
