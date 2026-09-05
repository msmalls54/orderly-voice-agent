import express, { type Router } from "express";
import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { redactPhone } from "../logger.js";
import { SmsStore } from "../store/store.js";
import {
  AgentPhoneCallEndedEventSchema,
  AgentPhoneTextMessageEventSchema,
  AgentPhoneVoiceMessageEventSchema,
  AgentPhoneWebhookEnvelopeSchema
} from "../agentphone/schemas.js";
import { verifyAgentPhoneWebhook } from "../agentphone/verify.js";
import type { VoiceTurnHandler, VoiceTurnResult } from "../types.js";

export interface WebhookDependencies {
  config: AppConfig;
  logger: AppLogger;
  store: SmsStore;
  onQueued?: () => void;
  voiceHandler?: VoiceTurnHandler;
  nowMs?: () => number;
}

export function createAgentPhoneWebhookRouter(deps: WebhookDependencies): Router {
  const router = express.Router();
  router.post(
    "/sms",
    express.raw({ type: "application/json", limit: deps.config.MAX_REQUEST_BODY_BYTES }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        res.status(415).json({ ok: false, code: "CONTENT_TYPE_REQUIRED" });
        return;
      }
      if (deps.config.SMS_PROVIDER === "agentphone" && !req.secure) {
        res.status(400).json({ ok: false, code: "HTTPS_REQUIRED" });
        return;
      }

      const verification = verifyAgentPhoneWebhook(
        req.body,
        {
          signature: req.get("x-webhook-signature"),
          timestamp: req.get("x-webhook-timestamp"),
          webhookId: req.get("x-webhook-id"),
          event: req.get("x-webhook-event")
        },
        deps.config.AGENTPHONE_WEBHOOK_SECRET ?? "mock-webhook-secret-not-for-production",
        deps.config.WEBHOOK_MAX_AGE_SECONDS,
        deps.nowMs?.() ?? Date.now()
      );
      if (!verification.ok) {
        deps.logger.warn({ event: "sms.webhook_rejected", reason: verification.reason }, "Rejected AgentPhone webhook");
        res.status(403).json({ ok: false, code: "WEBHOOK_REJECTED" });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(req.body.toString("utf8"));
      } catch {
        res.status(400).json({ ok: false, code: "INVALID_JSON" });
        return;
      }
      const envelope = AgentPhoneWebhookEnvelopeSchema.safeParse(payload);
      if (!envelope.success || envelope.data.event !== req.get("x-webhook-event")) {
        res.status(400).json({ ok: false, code: "INVALID_EVENT_ENVELOPE" });
        return;
      }
      if (envelope.data.agentId !== deps.config.AGENTPHONE_AGENT_ID) {
        deps.logger.warn({ event: "sms.agent_mismatch", deliveryId: verification.webhookId }, "Rejected event for a different AgentPhone agent");
        res.status(403).json({ ok: false, code: "AGENT_MISMATCH" });
        return;
      }
      if (verification.webhookId.startsWith("del_test_")) {
        deps.logger.info({ event: "sms.webhook_test_acknowledged", deliveryId: verification.webhookId }, "Acknowledged signed AgentPhone test delivery");
        res.status(200).json({ ok: true, ignored: true });
        return;
      }
      if (envelope.data.event === "agent.call_ended" && envelope.data.channel === "voice") {
        const ended = AgentPhoneCallEndedEventSchema.safeParse(payload);
        if (!ended.success) {
          deps.logger.warn({
            event: "voice.call_ended_payload_rejected",
            deliveryId: verification.webhookId,
            issues: ended.error.issues.slice(0, 8).map((issue) => ({
              code: issue.code,
              path: issue.path.join(".")
            }))
          }, "Rejected AgentPhone call-ended payload");
          res.status(400).json({ ok: false, code: "INVALID_CALL_ENDED_EVENT" });
          return;
        }
        if (deps.config.AGENTPHONE_NUMBER_ID && ended.data.data.numberId !== deps.config.AGENTPHONE_NUMBER_ID) {
          res.status(403).json({ ok: false, code: "NUMBER_MISMATCH" });
          return;
        }
        deps.logger.info({ event: "voice.call_ended", deliveryId: verification.webhookId }, "Acknowledged AgentPhone call end");
        res.status(200).json({ ok: true });
        return;
      }
      if (envelope.data.event === "agent.message" && envelope.data.channel === "voice") {
        const voice = AgentPhoneVoiceMessageEventSchema.safeParse(payload);
        if (!voice.success) {
          deps.logger.warn({
            event: "voice.payload_rejected",
            deliveryId: verification.webhookId,
            issues: voice.error.issues.slice(0, 8).map((issue) => ({
              code: issue.code,
              path: issue.path.join(".")
            }))
          }, "Rejected AgentPhone voice payload");
          res.status(400).json({ ok: false, code: "INVALID_VOICE_EVENT" });
          return;
        }
        if (deps.config.AGENTPHONE_NUMBER_ID && voice.data.data.numberId !== deps.config.AGENTPHONE_NUMBER_ID) {
          res.status(403).json({ ok: false, code: "NUMBER_MISMATCH" });
          return;
        }
        if (deps.config.AGENTPHONE_PHONE_NUMBER && voice.data.data.to !== deps.config.AGENTPHONE_PHONE_NUMBER) {
          res.status(403).json({ ok: false, code: "NUMBER_MISMATCH" });
          return;
        }
        if (!deps.config.ALLOWED_PHONES.includes(voice.data.data.from)) {
          deps.logger.warn({ event: "voice.sender_ignored", from: redactPhone(voice.data.data.from) }, "Ignored unauthorized voice caller");
          res.status(200).json({ text: "This line is not available for this caller.", hangup: true });
          return;
        }
        if (!deps.voiceHandler) {
          res.status(200).json({ text: "Voice ordering is not enabled yet. Please use the Orderly web demo.", hangup: true });
          return;
        }
        const confidence = voice.data.data.confidence;
        if (confidence !== undefined && confidence < deps.config.MIN_VOICE_CONFIRMATION_CONFIDENCE) {
          res.status(200).json({ text: "I did not hear that clearly enough. Please repeat it, or text the Orderly number." });
          return;
        }
        const cached = deps.store.voiceTurnResponse(verification.webhookId);
        if (cached) {
          res.status(200).json(JSON.parse(cached) as VoiceTurnResult);
          return;
        }
        const claimed = deps.store.beginVoiceTurn(verification.webhookId, voice.data.data.from);
        if (claimed === "failed") {
          res.status(200).json({ text: "That step failed safely earlier. I will not repeat any order action. Please check DoorDash or ask for help." });
          return;
        }
        if (claimed !== "new") {
          res.status(200).json({ text: "I am still checking that request. I will not repeat any order action." });
          return;
        }
        try {
          const result = await deps.voiceHandler.handle({
            deliveryId: verification.webhookId,
            sender: voice.data.data.from,
            transcript: voice.data.data.transcript,
            callId: voice.data.data.callId ?? "None"
          });
          const safeResult: VoiceTurnResult = {
            text: sanitizeSpeech(result.text),
            ...(result.hangup ? { hangup: true } : {})
          };
          const followUp = result.followUpSms && deps.config.LIVE_SMS_ENABLED && deps.config.SMS_OUTBOUND_VERIFIED
            ? {
                to: voice.data.data.from,
                body: sanitizeSpeech(result.followUpSms).slice(0, deps.config.MAX_SMS_LENGTH),
                dedupeKey: `voice-follow-up:${verification.webhookId}`
              }
            : undefined;
          deps.store.completeVoiceTurn(verification.webhookId, JSON.stringify(safeResult), followUp);
          if (followUp) deps.onQueued?.();
          res.status(200).json(safeResult);
        } catch (error) {
          deps.store.failVoiceTurn(verification.webhookId);
          deps.logger.error({ event: "voice.turn_failed", deliveryId: verification.webhookId }, "Voice turn failed safely");
          res.status(200).json({ text: "I could not safely finish that step. Nothing new will be submitted. Please check DoorDash or ask for help." });
        }
        return;
      }
      if (envelope.data.event !== "agent.message" || !["sms", "mms", "imessage"].includes(envelope.data.channel)) {
        deps.logger.info({ event: "sms.webhook_ignored", deliveryId: verification.webhookId }, "Acknowledged unsupported AgentPhone event");
        res.status(200).json({ ok: true, ignored: true });
        return;
      }
      const parsed = AgentPhoneTextMessageEventSchema.safeParse(payload);
      if (!parsed.success) {
        deps.logger.warn({
          event: "sms.payload_rejected",
          deliveryId: verification.webhookId,
          issues: parsed.error.issues.slice(0, 8).map((issue) => ({
            code: issue.code,
            path: issue.path.join(".")
          }))
        }, "Rejected AgentPhone payload");
        res.status(400).json({ ok: false, code: "INVALID_MESSAGE_EVENT" });
        return;
      }
      if (deps.config.AGENTPHONE_NUMBER_ID && parsed.data.data.numberId !== deps.config.AGENTPHONE_NUMBER_ID) {
        res.status(403).json({ ok: false, code: "NUMBER_MISMATCH" });
        return;
      }
      if (parsed.data.data.group || parsed.data.data.message.trim().length === 0) {
        deps.logger.info({ event: "sms.webhook_ignored", deliveryId: verification.webhookId }, "Acknowledged unsupported group or media-only message");
        res.status(200).json({ ok: true, ignored: true });
        return;
      }
      if (deps.config.AGENTPHONE_PHONE_NUMBER && parsed.data.data.to !== deps.config.AGENTPHONE_PHONE_NUMBER) {
        res.status(403).json({ ok: false, code: "NUMBER_MISMATCH" });
        return;
      }

      const sender = parsed.data.data.from;
      if (!deps.config.ALLOWED_PHONES.includes(sender)) {
        deps.logger.warn({ event: "sms.sender_ignored", from: redactPhone(sender) }, "Ignored unauthorized sender");
        res.status(200).json({ ok: true });
        return;
      }

      const accepted = deps.store.enqueueInbound({
        deliveryId: verification.webhookId,
        agentId: parsed.data.agentId,
        providerTimestampSeconds: verification.timestampSeconds,
        sender,
        body: parsed.data.data.message
      });
      deps.logger.info({
        event: accepted ? "sms.webhook_queued" : "sms.webhook_duplicate",
        deliveryId: verification.webhookId,
        from: redactPhone(sender)
      }, accepted ? "Queued inbound SMS" : "Acknowledged duplicate inbound SMS");

      // The database commit above happens before the acknowledgement. Slow
      // processing starts on a later event-loop turn.
      res.status(200).json({ ok: true });
      if (accepted && deps.onQueued) setImmediate(deps.onQueued);
    }
  );
  return router;
}

function sanitizeSpeech(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}
