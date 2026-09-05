import crypto from "node:crypto";
import { signAgentPhoneWebhook } from "../agentphone/verify.js";
import {
  DEMO_AGENT_ID,
  DEMO_NUMBER_ID,
  DEMO_SERVICE_PHONE,
  DEMO_USER_PHONE,
  DEMO_WEBHOOK_SECRET
} from "../demo-config.js";

const baseUrl = new URL(process.env["DEMO_BASE_URL"] ?? `http://127.0.0.1:${process.env["PORT"] ?? "8787"}`);
if (baseUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(baseUrl.hostname) || baseUrl.username || baseUrl.password) {
  throw new Error("DEMO_BASE_URL must be an unauthenticated local HTTP URL");
}

const timestamp = String(Math.floor(Date.now() / 1000));
const deliveryId = `del_demo_${crypto.randomUUID().replaceAll("-", "")}`;
const rawBody = Buffer.from(JSON.stringify({
  event: "agent.message",
  channel: "sms",
  timestamp: new Date().toISOString(),
  agentId: DEMO_AGENT_ID,
  data: {
    conversationId: "conv_orderly_local_demo",
    numberId: DEMO_NUMBER_ID,
    from: DEMO_USER_PHONE,
    to: DEMO_SERVICE_PHONE,
    message: "Show me the safe Orderly SMS prototype",
    mediaUrl: null,
    direction: "inbound",
    receivedAt: new Date().toISOString()
  },
  conversationState: null
}), "utf8");

const response = await fetch(new URL("/sms", baseUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-webhook-signature": signAgentPhoneWebhook(rawBody, timestamp, DEMO_WEBHOOK_SECRET),
    "x-webhook-timestamp": timestamp,
    "x-webhook-id": deliveryId,
    "x-webhook-event": "agent.message"
  },
  body: rawBody
});

if (!response.ok) {
  throw new Error(`Local demo webhook failed with HTTP ${response.status}`);
}

console.log(JSON.stringify({ ok: true, mode: "mock", webhookAccepted: true }));
