import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import { AgentPhoneSmsProvider } from "../src/agentphone/client.js";
import { signAgentPhoneWebhook } from "../src/agentphone/verify.js";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createLogger, redactPhone, safeError } from "../src/logger.js";
import { MockSmsProvider, type MockSendScenario } from "../src/mock/mock-provider.js";
import { CryptoBox } from "../src/security/crypto-box.js";
import { SmsStore } from "../src/store/store.js";
import { SmsProviderError, type MessageHandler } from "../src/types.js";
import { InboundWorker } from "../src/workers/inbound-worker.js";
import { WorkerLoop } from "../src/workers/loop.js";
import { OutboundWorker } from "../src/workers/outbound-worker.js";

const USER = "+14155550101";
const ADMIN = "+14155550102";
const SERVICE = "+14155550103";
const AGENT_ID = "agt_orderly_test";
const NUMBER_ID = "num_orderly_test";
const WEBHOOK_SECRET = "fake-webhook-secret-for-tests-only";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const PII_HASH_KEY = "fake-pii-hash-key-for-tests-only";

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    SMS_PROVIDER: "mock",
    LIVE_SMS_ENABLED: "false",
    SMS_OUTBOUND_VERIFIED: "false",
    AGENTPHONE_AGENT_ID: AGENT_ID,
    AGENTPHONE_NUMBER_ID: NUMBER_ID,
    AGENTPHONE_PHONE_NUMBER: SERVICE,
    AGENTPHONE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PUBLIC_WEBHOOK_URL: "https://orderly-test.invalid",
    ALLOWED_PHONES: `${USER},${ADMIN}`,
    ADMIN_PHONE: ADMIN,
    DATA_ENCRYPTION_KEY: ENCRYPTION_KEY,
    PII_HASH_KEY,
    LOG_LEVEL: "fatal",
    ...overrides
  });
}

function makeStore(filename = ":memory:", now: () => Date = () => new Date()): SmsStore {
  return new SmsStore(filename, new CryptoBox(ENCRYPTION_KEY, PII_HASH_KEY), now);
}

function messagePayload(from = USER, additions: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "agent.message",
    channel: "sms",
    timestamp: "2026-09-03T20:00:00Z",
    agentId: AGENT_ID,
    data: {
      conversationId: "conv_orderly_test",
      numberId: NUMBER_ID,
      from,
      to: SERVICE,
      message: "Hello Orderly",
      mediaUrl: null,
      direction: "inbound",
      receivedAt: "2026-09-03T20:00:00Z"
    },
    conversationState: null,
    ...additions
  };
}

function voicePayload(from = USER, additions: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "agent.message",
    channel: "voice",
    timestamp: "2026-09-03T20:00:00Z",
    agentId: AGENT_ID,
    data: {
      callId: "call_orderly_test",
      numberId: NUMBER_ID,
      from,
      to: SERVICE,
      status: "in-progress",
      transcript: "Order my last meal",
      confidence: 0.98,
      direction: "inbound"
    },
    conversationState: null,
    recentHistory: [],
    ...additions
  };
}

function callEndedPayload(additions: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "agent.call_ended",
    channel: "voice",
    timestamp: "2026-09-03T20:01:00Z",
    agentId: AGENT_ID,
    data: {
      callId: "call_orderly_test",
      numberId: NUMBER_ID,
      from: USER,
      to: SERVICE,
      direction: "inbound",
      status: "completed",
      startedAt: "2026-09-03T20:00:00Z",
      endedAt: "2026-09-03T20:01:00Z",
      durationSeconds: 60,
      transcript: [
        { role: "user", content: "Order my last meal", providerTurnId: "turn_beta_1" }
      ],
      providerCallMetadata: { region: "us-east" }
    },
    providerVersion: "beta",
    ...additions
  };
}

async function listen(app: Express): Promise<{ baseUrl: string; server: Server }> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

async function postSigned(
  baseUrl: string,
  payload: unknown,
  options: { webhookId?: string; timestampSeconds?: number; signature?: string; forwardedProto?: string; event?: string } = {}
): Promise<Response> {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const timestamp = String(options.timestampSeconds ?? 1_788_466_400);
  const signature = options.signature ?? signAgentPhoneWebhook(raw, timestamp, WEBHOOK_SECRET);
  return fetch(`${baseUrl}/sms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": signature,
      "x-webhook-timestamp": timestamp,
      "x-webhook-id": options.webhookId ?? "del_orderly_test_1",
      "x-webhook-event": options.event ?? "agent.message",
      ...(options.forwardedProto ? { "x-forwarded-proto": options.forwardedProto } : {})
    },
    body: raw
});
}

test("signed voice webhook returns and caches one safe response", async () => {
  const nowMs = 1_788_466_400_000;
  const config = makeConfig();
  const store = makeStore(":memory:", () => new Date(nowMs));
  let calls = 0;
  let lastCallId = "";
  const app = createApp({
    config,
    logger: createLogger(config),
    store,
    provider: new MockSmsProvider(),
    nowMs: () => nowMs,
    phoneVoiceHandler: {
      handle: async (turn) => {
        calls += 1;
        lastCallId = turn.callId;
        return { text: "Safe response <tool>hidden</tool>", hangup: false };
      }
    }
  });
  const { baseUrl, server } = await listen(app);
  try {
    const first = await postSigned(baseUrl, voicePayload(), { webhookId: "del_voice_1" });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { text: "Safe response hidden" });

    const duplicate = await postSigned(baseUrl, voicePayload(), { webhookId: "del_voice_1" });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { text: "Safe response hidden" });
    assert.equal(calls, 1);

    const providerExtended = voicePayload(USER, {
      data: {
        ...(voicePayload()["data"] as Record<string, unknown>),
        conversationId: "conv_voice_beta",
        receivedAt: "2026-09-03T20:00:00Z",
        confidence: "0.99"
      },
      recentHistory: [{
        content: "Welcome to Orderly",
        direction: "agent",
        channel: "call",
        at: 1_788_466_399,
        providerTurnId: "turn_beta_0"
      }],
      providerVersion: "beta"
    });
    const extended = await postSigned(baseUrl, providerExtended, { webhookId: "del_voice_provider_extended" });
    assert.equal(extended.status, 200);
    assert.deepEqual(await extended.json(), { text: "Safe response hidden" });
    assert.equal(calls, 2);

    const liveBetaQuirks = voicePayload(USER, {
      data: {
        ...(voicePayload()["data"] as Record<string, unknown>),
        callId: "None",
        from: "tel:+1 (415) 555-0101",
        to: "1-415-555-0103",
        confidence: "None",
        transcript: ""
      }
    });
    const quirks = await postSigned(baseUrl, liveBetaQuirks, { webhookId: "del_voice_live_beta_quirks" });
    assert.equal(quirks.status, 200);
    assert.deepEqual(await quirks.json(), { text: "Safe response hidden" });
    assert.equal(calls, 3);
    assert.equal(lastCallId, "None");

    const untrustedConfirmation = voicePayload(USER, {
      data: {
        ...(voicePayload()["data"] as Record<string, unknown>),
        confidence: null,
        transcript: "Confirm demo order 4186"
      }
    });
    const acceptedConfirmation = await postSigned(baseUrl, untrustedConfirmation, { webhookId: "del_voice_missing_confidence_confirmation" });
    assert.equal(acceptedConfirmation.status, 200);
    assert.deepEqual(await acceptedConfirmation.json(), { text: "Safe response hidden" });
    assert.equal(calls, 4);

    let expectedCalls = 4;
    for (const [suffix, transcript] of [
      ["yes", "Yes"],
      ["spaces", "yes  please"],
      ["newline", "yes\nplease"],
      ["fullwidth", "ｙｅｓ"],
      ["punctuated", "Yes, please."],
      ["synonym", "Yeah."]
    ] as const) {
      const untrustedNaturalConfirmation = voicePayload(USER, {
        data: {
          ...(voicePayload()["data"] as Record<string, unknown>),
          confidence: null,
          transcript
        }
      });
      const acceptedNaturalConfirmation = await postSigned(baseUrl, untrustedNaturalConfirmation, { webhookId: `del_voice_missing_confidence_${suffix}` });
      assert.equal(acceptedNaturalConfirmation.status, 200);
      assert.deepEqual(await acceptedNaturalConfirmation.json(), { text: "Safe response hidden" });
      expectedCalls += 1;
      assert.equal(calls, expectedCalls);
    }

    const untrustedCardConfirmation = voicePayload(USER, {
      data: {
        ...(voicePayload()["data"] as Record<string, unknown>),
        confidence: null,
        transcript: "Charge Visa ending 1111 and place order 4186 for $25.00"
      }
    });
    const acceptedCardConfirmation = await postSigned(baseUrl, untrustedCardConfirmation, { webhookId: "del_voice_missing_confidence_card_confirmation" });
    assert.equal(acceptedCardConfirmation.status, 200);
    assert.deepEqual(await acceptedCardConfirmation.json(), { text: "Safe response hidden" });
    assert.equal(calls, 11);

    const endedPayload = callEndedPayload();
    (endedPayload["data"] as Record<string, unknown>)["durationSeconds"] = "60.5";
    const ended = await postSigned(baseUrl, endedPayload, {
      webhookId: "del_voice_call_ended_extended",
      event: "agent.call_ended"
    });
    assert.equal(ended.status, 200);

    const endedWithoutDuration = callEndedPayload();
    (endedWithoutDuration["data"] as Record<string, unknown>)["durationSeconds"] = "None";
    const endedNone = await postSigned(baseUrl, endedWithoutDuration, {
      webhookId: "del_voice_call_ended_without_duration",
      event: "agent.call_ended"
    });
    assert.equal(endedNone.status, 200);

    const lowConfidence = voicePayload(USER, {
      data: { ...(voicePayload()["data"] as Record<string, unknown>), confidence: 0.5, transcript: "Yes" }
    });
    const lowScoreAccepted = await postSigned(baseUrl, lowConfidence, { webhookId: "del_voice_low_confidence" });
    assert.equal(lowScoreAccepted.status, 200);
    assert.deepEqual(await lowScoreAccepted.json(), { text: "Safe response hidden" });
    assert.equal(calls, 12);

    const unauthorized = await postSigned(baseUrl, voicePayload("+14155550999"), { webhookId: "del_voice_unknown" });
    assert.equal(unauthorized.status, 200);
    assert.equal((await unauthorized.json() as { hangup: boolean }).hangup, true);
    assert.equal(calls, 12);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("signed inbound webhook is durable before ack and produces one mock reply", async () => {
  const nowMs = 1_788_466_400_000;
  const config = makeConfig();
  const logger = createLogger(config);
  const store = makeStore(":memory:", () => new Date(nowMs));
  const provider = new MockSmsProvider(["success"]);
  const app = createApp({ config, logger, store, provider, nowMs: () => nowMs });
  const { baseUrl, server } = await listen(app);
  try {
    const response = await postSigned(baseUrl, messagePayload());
    assert.equal(response.status, 200);
    assert.equal(store.inboundCount(), 1, "event must be committed before the HTTP acknowledgement");
    assert.equal(store.outboundCount(), 0, "slow processing has not run in the request handler");

    const handler: MessageHandler = { retrySafety: "idempotent", handle: async () => "Orderly: mock reply. Reply STOP to unsubscribe." };
    const inbound = new InboundWorker(store, handler, config, logger);
    const outbound = new OutboundWorker(store, provider, config, logger, () => 0);
    assert.equal(await inbound.runOnce(), true);
    assert.equal(store.outboundCount("user_reply"), 1);
    assert.equal(await outbound.runOnce(), true);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]?.to, USER);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("duplicate inbound webhook is acknowledged but processed once", async () => {
  const nowMs = 1_788_466_400_000;
  const config = makeConfig();
  const store = makeStore(":memory:", () => new Date(nowMs));
  const provider = new MockSmsProvider();
  const app = createApp({ config, logger: createLogger(config), store, provider, nowMs: () => nowMs });
  const { baseUrl, server } = await listen(app);
  try {
    const first = await postSigned(baseUrl, messagePayload(), { webhookId: "del_duplicate_1" });
    const second = await postSigned(baseUrl, messagePayload(), { webhookId: "del_duplicate_1" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(store.inboundCount(), 1);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("invalid signature, stale timestamp, malformed payload, and wrong agent fail closed", async () => {
  const nowMs = 1_788_466_400_000;
  const config = makeConfig();
  const store = makeStore(":memory:", () => new Date(nowMs));
  const provider = new MockSmsProvider();
  const app = createApp({ config, logger: createLogger(config), store, provider, nowMs: () => nowMs });
  const { baseUrl, server } = await listen(app);
  try {
    const badSignature = await postSigned(baseUrl, messagePayload(), { signature: `sha256=${"0".repeat(64)}` });
    assert.equal(badSignature.status, 403);

    const stale = await postSigned(baseUrl, messagePayload(), { timestampSeconds: 1_788_465_000, webhookId: "del_stale_1" });
    assert.equal(stale.status, 403);

    const malformed = await postSigned(baseUrl, { ...messagePayload(), unexpected: true }, { webhookId: "del_malformed_1" });
    assert.equal(malformed.status, 400);

    const wrongAgent = await postSigned(baseUrl, messagePayload(USER, { agentId: "agt_other_test" }), { webhookId: "del_wrong_agent_1" });
    assert.equal(wrongAgent.status, 403);
    assert.equal(store.inboundCount(), 0);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("signed AgentPhone self-test is acknowledged without weakening real-message validation", async () => {
  const nowMs = 1_788_466_400_000;
  const config = makeConfig();
  const store = makeStore(":memory:", () => new Date(nowMs));
  const app = createApp({ config, logger: createLogger(config), store, provider: new MockSmsProvider(), nowMs: () => nowMs });
  const { baseUrl, server } = await listen(app);
  const providerTestPayload = {
    event: "agent.message",
    channel: "sms",
    timestamp: "2026-09-03T20:00:00Z",
    agentId: AGENT_ID,
    data: {
      from: "+15555550100",
      to: "+15555550101",
      message: "AgentPhone webhook test",
      direction: "inbound",
      receivedAt: "2026-09-03T20:00:00Z",
      test: true
    }
  };
  try {
    const accepted = await postSigned(baseUrl, providerTestPayload, { webhookId: "del_test_demo_1" });
    assert.equal(accepted.status, 200);
    assert.equal(store.inboundCount(), 0);

    const wrongAgent = await postSigned(
      baseUrl,
      { ...providerTestPayload, agentId: "agt_other_test" },
      { webhookId: "del_test_wrong_agent_1" }
    );
    assert.equal(wrongAgent.status, 403);
    assert.equal(store.inboundCount(), 0);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("signed group and media-only messages are acknowledged without queuing work", async () => {
  const nowMs = 1_788_466_400_000;
  const config = makeConfig();
  const store = makeStore(":memory:", () => new Date(nowMs));
  const provider = new MockSmsProvider();
  const app = createApp({ config, logger: createLogger(config), store, provider, nowMs: () => nowMs });
  const { baseUrl, server } = await listen(app);
  try {
    const base = messagePayload();
    const data = base["data"] as Record<string, unknown>;
    const mediaOnly = await postSigned(baseUrl, {
      ...base,
      data: { ...data, message: "", mediaUrl: "https://media.example.invalid/demo.png" }
    }, { webhookId: "del_media_only_1" });
    assert.equal(mediaOnly.status, 200);

    const group = await postSigned(baseUrl, {
      ...base,
      data: { ...data, group: { isGroup: true, groupId: "group_demo_1" } }
    }, { webhookId: "del_group_1" });
    assert.equal(group.status, 200);
    assert.equal(store.inboundCount(), 0);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("AgentPhone mode rejects insecure webhook transport and honors the configured proxy hop", async () => {
  const nowMs = 1_788_466_400_000;
  const config = makeConfig({
    SMS_PROVIDER: "agentphone",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    TRUST_PROXY_HOPS: "1"
  });
  const store = makeStore(":memory:", () => new Date(nowMs));
  const app = createApp({ config, logger: createLogger(config), store, provider: new MockSmsProvider(), nowMs: () => nowMs });
  const { baseUrl, server } = await listen(app);
  try {
    const insecure = await postSigned(baseUrl, messagePayload(), { webhookId: "del_insecure_1" });
    assert.equal(insecure.status, 400);
    assert.equal(store.inboundCount(), 0);

    const proxiedHttps = await postSigned(baseUrl, messagePayload(), {
      webhookId: "del_proxied_https_1",
      forwardedProto: "https"
    });
    assert.equal(proxiedHttps.status, 200);
    assert.equal(store.inboundCount(), 1);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("unauthorized sender receives no queued work or reply", async () => {
  const nowMs = 1_788_466_400_000;
  const config = makeConfig();
  const store = makeStore(":memory:", () => new Date(nowMs));
  const provider = new MockSmsProvider();
  const app = createApp({ config, logger: createLogger(config), store, provider, nowMs: () => nowMs });
  const { baseUrl, server } = await listen(app);
  try {
    const response = await postSigned(baseUrl, messagePayload("+14155550999"), { webhookId: "del_unknown_1" });
    assert.equal(response.status, 200);
    assert.equal(store.inboundCount(), 0);
    assert.equal(store.outboundCount(), 0);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("STOP persists opt-out, suppresses ordinary replies, and START resumes", async () => {
  const now = () => new Date("2026-09-03T20:00:00Z");
  const config = makeConfig();
  const store = makeStore(":memory:", now);
  const handler: MessageHandler = { retrySafety: "idempotent", handle: async () => "ordinary reply" };
  const worker = new InboundWorker(store, handler, config, createLogger(config));
  const enqueue = (id: string, body: string) => store.enqueueInbound({
    deliveryId: id, agentId: AGENT_ID, providerTimestampSeconds: 1_788_466_400, sender: USER, body
  });
  try {
    enqueue("del_stop_1", "STOP");
    await worker.runOnce();
    assert.equal(store.isOptedOut(USER), true);
    assert.equal(store.outboundCount("compliance_reply"), 1);

    enqueue("del_after_stop_1", "order lunch");
    await worker.runOnce();
    assert.equal(store.outboundCount("user_reply"), 0, "ordinary message after STOP must be silent");

    enqueue("del_start_1", "START");
    await worker.runOnce();
    assert.equal(store.isOptedOut(USER), false);
    assert.equal(store.outboundCount("compliance_reply"), 2);
  } finally {
    store.close();
  }
});

test("STOP atomically cancels a reply that was queued before the opt-out", async () => {
  const config = makeConfig();
  const store = makeStore();
  const handler: MessageHandler = { retrySafety: "idempotent", handle: async () => "ordinary reply" };
  const inbound = new InboundWorker(store, handler, config, createLogger(config));
  try {
    const queuedReply = store.enqueueOutbound("user_reply", USER, "Orderly: queued before STOP", "queued-before-stop");
    store.enqueueInbound({
      deliveryId: "del_stop_cancels_queue",
      agentId: AGENT_ID,
      providerTimestampSeconds: 1_788_466_400,
      sender: USER,
      body: "STOP"
    });
    await inbound.runOnce();
    assert.equal(store.outboundStatus(queuedReply)?.status, "cancelled");
    assert.equal(store.outboundCount("compliance_reply"), 1);
  } finally {
    store.close();
  }
});

test("outbound worker rechecks opt-out after claiming and immediately before provider send", async () => {
  const config = makeConfig();
  const store = makeStore();
  const provider = new MockSmsProvider(["success"]);
  const originalClaim = store.claimOutbound.bind(store);
  let injectedStop = false;
  store.claimOutbound = (adminPhone: string, leaseSeconds?: number) => {
    const job = originalClaim(adminPhone, leaseSeconds);
    if (job && !injectedStop) {
      injectedStop = true;
      store.setOptedOut(job.to, true);
    }
    return job;
  };
  const outbound = new OutboundWorker(store, provider, config, createLogger(config), () => 0);
  try {
    const id = store.enqueueOutbound("user_reply", USER, "Orderly: queued reply", "claimed-before-stop");
    assert.equal(await outbound.runOnce(), true);
    assert.equal(store.outboundStatus(id)?.status, "cancelled");
    assert.equal(provider.calls.length, 0);
  } finally {
    store.close();
  }
});

test("a non-idempotent business handler is not retried after failure", async () => {
  const config = makeConfig({ MAX_INBOUND_ATTEMPTS: "5" });
  const store = makeStore();
  let calls = 0;
  const handler: MessageHandler = {
    retrySafety: "unknown",
    handle: async (message) => {
      calls += 1;
      assert.equal(message.idempotencyKey, "agentphone:del_non_idempotent");
      throw Object.assign(new Error("fake business failure"), { code: "BUSINESS_OUTCOME_UNKNOWN" });
    }
  };
  const inbound = new InboundWorker(store, handler, config, createLogger(config));
  try {
    store.enqueueInbound({
      deliveryId: "del_non_idempotent",
      agentId: AGENT_ID,
      providerTimestampSeconds: 1_788_466_400,
      sender: USER,
      body: "do something"
    });
    await inbound.runOnce();
    assert.equal(await inbound.runOnce(), false);
    assert.equal(calls, 1);
    assert.equal(store.inboundActionStatus("del_non_idempotent"), "ambiguous");
    assert.equal(store.queueHealth().inboundFailed, 1);
    assert.equal(store.outboundCount("admin_alert"), 1);
  } finally {
    store.close();
  }
});

test("a successful non-idempotent handler commits its action outcome and reply atomically", async () => {
  const config = makeConfig();
  const store = makeStore();
  const handler: MessageHandler = {
    retrySafety: "unknown",
    handle: async ({ idempotencyKey }) => {
      assert.equal(idempotencyKey, "agentphone:del_non_idempotent_success");
      return "Orderly: action completed once";
    }
  };
  const inbound = new InboundWorker(store, handler, config, createLogger(config));
  try {
    store.enqueueInbound({
      deliveryId: "del_non_idempotent_success",
      agentId: AGENT_ID,
      providerTimestampSeconds: 1_788_466_400,
      sender: USER,
      body: "perform one action"
    });
    assert.equal(await inbound.runOnce(), true);
    assert.equal(store.inboundActionStatus("del_non_idempotent_success"), "completed");
    assert.equal(store.queueHealth().inboundFailed, 0);
    assert.equal(store.outboundCount("user_reply"), 1);
  } finally {
    store.close();
  }
});

test("an interrupted non-idempotent action becomes ambiguous and is never replayed", () => {
  let nowMs = new Date("2026-09-03T20:00:00Z").getTime();
  const store = makeStore(":memory:", () => new Date(nowMs));
  try {
    store.enqueueInbound({
      deliveryId: "del_action_crash",
      agentId: AGENT_ID,
      providerTimestampSeconds: 1_788_466_400,
      sender: USER,
      body: "perform one action"
    });
    const firstClaim = store.claimInbound(ADMIN, 1);
    assert.equal(firstClaim?.deliveryId, "del_action_crash");
    store.beginInboundAction(firstClaim!, "agentphone:del_action_crash");

    nowMs += 2_000;
    assert.equal(store.claimInbound(ADMIN), undefined);
    assert.equal(store.inboundActionStatus("del_action_crash"), "ambiguous");
    assert.equal(store.queueHealth().inboundFailed, 1);
    assert.equal(store.outboundCount("admin_alert"), 1);
  } finally {
    store.close();
  }
});

test("an interrupted retry-safe inbound job is released with the same idempotency key", () => {
  let nowMs = new Date("2026-09-03T20:00:00Z").getTime();
  const store = makeStore(":memory:", () => new Date(nowMs));
  try {
    store.enqueueInbound({
      deliveryId: "del_idempotent_crash",
      agentId: AGENT_ID,
      providerTimestampSeconds: 1_788_466_400,
      sender: USER,
      body: "retry safely"
    });
    assert.equal(store.claimInbound(ADMIN, 1)?.attempts, 1);
    nowMs += 2_000;
    const recovered = store.claimInbound(ADMIN);
    assert.equal(recovered?.deliveryId, "del_idempotent_crash");
    assert.equal(recovered?.attempts, 2);
    assert.equal(store.inboundActionStatus("del_idempotent_crash"), undefined);
  } finally {
    store.close();
  }
});

test("explicit transient rate limit retries, then succeeds", async () => {
  const now = () => new Date("2026-09-03T20:00:00Z");
  const config = makeConfig();
  const store = makeStore(":memory:", now);
  const provider = new MockSmsProvider(["rate_limit", "success"]);
  const worker = new OutboundWorker(store, provider, config, createLogger(config), () => 0);
  try {
    const id = store.enqueueOutbound("user_reply", USER, "Orderly: hello", "retry-test");
    await worker.runOnce();
    assert.deepEqual(store.outboundStatus(id), { status: "queued", attempts: 1 });
    await worker.runOnce();
    assert.deepEqual(store.outboundStatus(id), { status: "accepted", attempts: 2 });
    assert.equal(provider.calls.length, 2);
  } finally {
    store.close();
  }
});

test("API rejection fails once and queues a durable administrator alert", async () => {
  const config = makeConfig();
  const store = makeStore();
  const provider = new MockSmsProvider(["api_rejection", "success"]);
  const worker = new OutboundWorker(store, provider, config, createLogger(config), () => 0);
  try {
    const id = store.enqueueOutbound("user_reply", USER, "Orderly: hello", "reject-test");
    await worker.runOnce();
    assert.deepEqual(store.outboundStatus(id), { status: "failed", attempts: 1 });
    assert.equal(store.outboundCount("admin_alert"), 1);
    await worker.runOnce();
    assert.equal(provider.calls[1]?.to, ADMIN);
  } finally {
    store.close();
  }
});

test("timeout is ambiguous, never retried, and alerts the administrator", async () => {
  const config = makeConfig();
  const store = makeStore();
  const provider = new MockSmsProvider(["timeout", "success"]);
  const worker = new OutboundWorker(store, provider, config, createLogger(config), () => 0);
  try {
    const id = store.enqueueOutbound("user_reply", USER, "Orderly: hello", "timeout-test");
    await worker.runOnce();
    assert.deepEqual(store.outboundStatus(id), { status: "ambiguous", attempts: 1 });
    await worker.runOnce();
    assert.equal(provider.calls.filter((call) => call.to === USER).length, 1);
    assert.equal(provider.calls.filter((call) => call.to === ADMIN).length, 1);
  } finally {
    store.close();
  }
});

test("an interrupted sending lease becomes ambiguous instead of being resent", () => {
  let nowMs = new Date("2026-09-03T20:00:00Z").getTime();
  const store = makeStore(":memory:", () => new Date(nowMs));
  try {
    const id = store.enqueueOutbound("user_reply", USER, "Orderly: crash-window test", "crash-window");
    const firstClaim = store.claimOutbound(ADMIN, 1);
    assert.equal(firstClaim?.id, id);
    nowMs += 2_000;
    const nextClaim = store.claimOutbound(ADMIN);
    assert.equal(store.outboundStatus(id)?.status, "ambiguous");
    assert.equal(nextClaim?.kind, "admin_alert");
    assert.equal(store.queueHealth().outboundAmbiguous, 1);
  } finally {
    store.close();
  }
});

test("retryable rejections stop at the attempt cap and surface failure", async () => {
  const config = makeConfig({ MAX_OUTBOUND_ATTEMPTS: "3" });
  const store = makeStore(":memory:", () => new Date("2026-09-03T20:00:00Z"));
  const scenarios: MockSendScenario[] = ["rate_limit", "rate_limit", "rate_limit", "success"];
  const provider = new MockSmsProvider(scenarios);
  const worker = new OutboundWorker(store, provider, config, createLogger(config), () => 0);
  try {
    const id = store.enqueueOutbound("user_reply", USER, "Orderly: hello", "exhaust-test");
    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();
    assert.deepEqual(store.outboundStatus(id), { status: "failed", attempts: 3 });
    await worker.runOnce();
    assert.equal(provider.calls.filter((call) => call.to === USER).length, 3);
    assert.equal(provider.calls.filter((call) => call.to === ADMIN).length, 1);
  } finally {
    store.close();
  }
});

test("administrator-alert failure is visible and does not recurse", async () => {
  const config = makeConfig();
  const store = makeStore();
  const provider = new MockSmsProvider(["api_rejection"]);
  const worker = new OutboundWorker(store, provider, config, createLogger(config), () => 0);
  try {
    store.enqueueOutbound("admin_alert", ADMIN, "Orderly test alert", "admin-fail-test");
    await worker.runOnce();
    const health = store.queueHealth();
    assert.equal(health.failedAdminAlerts, 1);
    assert.equal(store.outboundCount("admin_alert"), 1, "failed alert must not create another alert");
  } finally {
    store.close();
  }
});

test("worker loop catches task and error-reporter failures and backs off", async () => {
  let calls = 0;
  let releaseObserved!: () => void;
  const observed = new Promise<void>((resolve) => { releaseObserved = resolve; });
  const loop = new WorkerLoop(
    async () => {
      calls += 1;
      throw Object.assign(new Error("fake worker failure"), { code: "FAKE_WORKER_FAILURE" });
    },
    10,
    () => {
      releaseObserved();
      throw new Error("fake reporter failure");
    }
  );
  loop.start();
  try {
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls, 1, "the worker must not spin during its failure backoff");
    assert.equal(loop.health().lastErrorCode, "FAKE_WORKER_FAILURE");
  } finally {
    await loop.stop();
  }
});

test("queued inbound and outbound state survives application restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orderly-agentphone-test-"));
  const database = path.join(directory, "queue.db");
  const config = makeConfig();
  const first = makeStore(database);
  first.enqueueInbound({
    deliveryId: "del_restart_inbound", agentId: AGENT_ID, providerTimestampSeconds: 1_788_466_400, sender: USER, body: "hello"
  });
  first.enqueueOutbound("admin_alert", ADMIN, "Orderly restart alert", "restart-outbound");
  first.close();

  const second = makeStore(database);
  const provider = new MockSmsProvider(["success", "success"]);
  const inbound = new InboundWorker(second, { retrySafety: "idempotent", handle: async () => "Orderly: restart reply" }, config, createLogger(config));
  const outbound = new OutboundWorker(second, provider, config, createLogger(config), () => 0);
  try {
    await inbound.runOnce();
    await outbound.runUntilIdle();
    assert.equal(provider.calls.length, 2);
    assert.equal(second.queueHealth().outboundQueued, 0);
  } finally {
    second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restart recovery fails closed for interrupted voice and order actions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orderly-phone-recovery-test-"));
  const database = path.join(directory, "queue.db");
  const first = makeStore(database);
  try {
    assert.equal(first.beginVoiceTurn("del_interrupted_voice", USER), "new");
    assert.equal(first.saveConversationState(USER, 0, JSON.stringify({ stage: "awaiting_confirmation" })), 1);
    assert.equal(first.beginOrderSubmission({
      phone: USER,
      expectedSessionVersion: 1,
      nextStateJson: JSON.stringify({ stage: "submitting" }),
      approvalId: "11111111-1111-4111-8111-111111111111",
      purchaseRunId: "22222222-2222-4222-8222-222222222222",
      previewHash: `sha256:${"a".repeat(64)}`,
      idempotencyKey: `sha256:${"b".repeat(64)}`
    }), 2);
    assert.deepEqual(first.beginCartPreparation("cart-attempt-interrupted"), { status: "acquired" });
    assert.equal(first.markCartPreparationMutating("cart-attempt-interrupted"), true);
  } finally {
    first.close();
  }

  const second = makeStore(database);
  try {
    assert.deepEqual(second.recoverInterruptedPhoneActions(), {
      voiceTurnsFailed: 1,
      orderSubmissionsAmbiguous: 1,
      cartChecksReleased: 0,
      cartPreparationsUncertain: 1
    });
    const health = second.queueHealth();
    assert.equal(health.voiceProcessing, 0);
    assert.equal(health.voiceFailed, 1);
    assert.equal(health.orderSubmissionsAmbiguous, 1);
    assert.equal(health.cartPreparationsUncertain, 1);
    assert.equal(second.resolveUncertainCartPreparationAfterReview(), true);
    assert.equal(second.queueHealth().cartPreparationsUncertain, 0);
  } finally {
    second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("consumed purchase-run guards survive restart while a fresh run preserves the earlier ledger", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orderly-purchase-run-restart-test-"));
  const database = path.join(directory, "queue.db");
  const firstRunId = "11111111-1111-4111-8111-111111111111";
  const secondRunId = "22222222-2222-4222-8222-222222222222";
  const firstApproval = "33333333-3333-4333-8333-333333333333";
  const secondApproval = "44444444-4444-4444-8444-444444444444";
  const first = makeStore(database);
  try {
    assert.equal(first.saveConversationState(USER, 0, JSON.stringify({ stage: "awaiting_confirmation" })), 1);
    assert.equal(first.beginOrderSubmission({
      phone: USER,
      expectedSessionVersion: 1,
      nextStateJson: JSON.stringify({ stage: "submitting" }),
      approvalId: firstApproval,
      purchaseRunId: firstRunId,
      previewHash: `sha256:${"c".repeat(64)}`,
      idempotencyKey: `sha256:${"d".repeat(64)}`
    }), 2);
    assert.equal(first.completeOrderSubmission({
      phone: USER,
      expectedSessionVersion: 2,
      nextStateJson: JSON.stringify({ stage: "placed" }),
      approvalId: firstApproval,
      status: "placed",
      orderRef: "order_first_restart_test",
      safeSummary: "DoorDash placed the first test order."
    }), 3);
    assert.equal(first.orderSubmissionCount(), 1);
  } finally {
    first.close();
  }

  const second = makeStore(database);
  try {
    assert.equal(second.purchaseRunConsumed(firstRunId), true);
    assert.equal(second.beginOrderSubmission({
      phone: USER,
      expectedSessionVersion: 3,
      nextStateJson: JSON.stringify({ stage: "submitting" }),
      approvalId: secondApproval,
      purchaseRunId: secondRunId,
      previewHash: `sha256:${"e".repeat(64)}`,
      idempotencyKey: `sha256:${"f".repeat(64)}`
    }), 4);
    assert.equal(second.purchaseRunConsumed(firstRunId), true);
    assert.equal(second.purchaseRunConsumed(secondRunId), true);
    assert.equal(second.orderSubmissionCount(), 2);
  } finally {
    second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("health endpoints report readiness and failed backlog without secrets", async () => {
  const config = makeConfig();
  const store = makeStore();
  const provider = new MockSmsProvider(["api_rejection"]);
  const logger = createLogger(config);
  const app = createApp({ config, logger, store, provider });
  const { baseUrl, server } = await listen(app);
  try {
    const healthy = await fetch(`${baseUrl}/health`);
    assert.equal(healthy.status, 200);
    const id = store.enqueueOutbound("admin_alert", ADMIN, "test", "health-failure");
    const worker = new OutboundWorker(store, provider, config, logger, () => 0);
    await worker.runOnce();
    assert.equal(store.outboundStatus(id)?.status, "failed");
    const unhealthy = await fetch(`${baseUrl}/health/queue`);
    assert.equal(unhealthy.status, 503);
    const body = JSON.stringify(await unhealthy.json());
    assert.equal(body.includes(WEBHOOK_SECRET), false);
    assert.equal(body.includes(USER), false);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("aggregate readiness fails when an enabled worker reports an error", async () => {
  const config = makeConfig();
  const store = makeStore();
  const healthyWorker = {
    running: false,
    lastStartedAt: "2026-09-03T20:00:00.000Z",
    lastCompletedAt: "2026-09-03T20:00:01.000Z",
    lastErrorAt: null,
    lastErrorCode: null
  };
  const failedWorker = {
    ...healthyWorker,
    lastErrorAt: "2026-09-03T20:00:02.000Z",
    lastErrorCode: "WORKER_LOOP_ERROR"
  };
  const app = createApp({
    config,
    logger: createLogger(config),
    store,
    provider: new MockSmsProvider(),
    workerHealth: () => ({ inbound: failedWorker, outbound: healthyWorker, enabled: true })
  });
  const { baseUrl, server } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 503);
    const body = await response.json() as { ok: boolean; workersReady: boolean };
    assert.equal(body.ok, false);
    assert.equal(body.workersReady, false);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("typed AgentPhone adapter uses the documented endpoint and redacted receipt fields", async () => {
  const config = makeConfig({
    SMS_PROVIDER: "agentphone",
    LIVE_SMS_ENABLED: "true",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    AGENTPHONE_API_KEY: "fake-agentphone-api-key"
  });
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const request = async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      id: "msg_fake_1", status: "sent", channel: "sms", from_number: SERVICE, to_number: USER, media_urls: []
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = new AgentPhoneSmsProvider(config, request);
  const receipt = await provider.send({ to: USER, body: "Orderly: fake test", kind: "user_reply" });
  assert.equal(requestUrl, "https://api.agentphone.ai/v1/messages");
  assert.equal((requestInit?.headers as Record<string, string>)["authorization"], "Bearer fake-agentphone-api-key");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    agent_id: AGENT_ID, to_number: USER, body: "Orderly: fake test"
  });
  assert.deepEqual(receipt, { providerMessageId: "msg_fake_1", providerStatus: "sent", channel: "sms" });
});

test("AgentPhone 5xx is ambiguous because sends have no idempotency key", async () => {
  const config = makeConfig({
    SMS_PROVIDER: "agentphone",
    LIVE_SMS_ENABLED: "true",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    AGENTPHONE_API_KEY: "fake-agentphone-api-key"
  });
  const provider = new AgentPhoneSmsProvider(config, async () => new Response(
    JSON.stringify({ error: { code: "SMS_PROVIDER_ERROR", message: "fake", type: "provider_error" } }),
    { status: 502, headers: { "content-type": "application/json" } }
  ));
  await assert.rejects(
    provider.send({ to: USER, body: "Orderly: fake test", kind: "user_reply" }),
    (error: unknown) => error instanceof SmsProviderError && error.ambiguous && !error.retryable
  );
});

test("per-agent webhook setup is gated and hands the rotated secret only to a persistence callback", async () => {
  const config = makeConfig({
    SMS_PROVIDER: "agentphone",
    LIVE_SMS_ENABLED: "true",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    AGENTPHONE_WEBHOOK_SETUP_ENABLED: "true",
    AGENTPHONE_API_KEY: "fake-agentphone-api-key"
  });
  let persisted = "";
  let body: unknown;
  let calls = 0;
  const provider = new AgentPhoneSmsProvider(config, async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(init?.method, "GET");
      return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    }
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: "wh_fake_1",
      url: "https://orderly-test.invalid/sms",
      secret: "fake-rotated-webhook-secret",
      status: "active",
      contextLimit: 0,
      timeout: 30,
      createdAt: "2026-09-03T20:00:00Z"
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const result = await provider.configureIsolatedWebhook(null, async (secret) => { persisted = secret; });
  assert.deepEqual(body, { url: "https://orderly-test.invalid/sms", contextLimit: 0, timeout: 30 });
  assert.equal(persisted, "fake-rotated-webhook-secret");
  assert.deepEqual(result, { webhookId: "wh_fake_1", status: "active" });
});

test("log helpers mask phones and discard error messages", () => {
  assert.equal(redactPhone(USER).includes(USER), false);
  const safe = safeError(Object.assign(new Error(`secret ${WEBHOOK_SECRET}`), { code: "FAKE_ERROR" }));
  assert.deepEqual(safe, { name: "Error", code: "FAKE_ERROR" });
  assert.equal(JSON.stringify(safe).includes(WEBHOOK_SECRET), false);
});

test("mock checkout hash is bound to the exact canonical snapshot", () => {
  const fixture = JSON.parse(fs.readFileSync(path.resolve("fixtures/mock-checkout-preview.json"), "utf8")) as {
    canonical_snapshot: unknown;
    checkout_hash: string;
  };
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify(fixture.canonical_snapshot))
    .digest("hex");
  assert.equal(fixture.checkout_hash, `sha256:${digest}`);
});
