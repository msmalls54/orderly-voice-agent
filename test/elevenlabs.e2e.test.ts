import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { MockSmsProvider } from "../src/mock/mock-provider.js";
import { CryptoBox } from "../src/security/crypto-box.js";
import { SmsStore } from "../src/store/store.js";

const AGENT_ID = "agent_0201m1na5ka1fra9f3bm00nmkbv3";
const API_KEY = "sk_fake-elevenlabs-key";

function makeConfig() {
  return loadConfig({
    SMS_PROVIDER: "mock",
    LIVE_SMS_ENABLED: "false",
    SMS_OUTBOUND_VERIFIED: "false",
    ALLOWED_PHONES: "+14155550101,+14155550102",
    ADMIN_PHONE: "+14155550102",
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
    PII_HASH_KEY: "fake-pii-hash-key-for-voice-tests",
    ELEVENLABS_API_KEY: API_KEY,
    ELEVENLABS_AGENT_ID: AGENT_ID,
    VOICE_SESSION_LIMIT: "2",
    VOICE_SESSION_WINDOW_SECONDS: "600",
    LOG_LEVEL: "fatal"
  });
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

test("voice session endpoint keeps the API key server-side and returns the signed URL", async () => {
  const config = makeConfig();
  const store = new SmsStore(":memory:", new CryptoBox(config.DATA_ENCRYPTION_KEY, config.PII_HASH_KEY));
  let observedKey = "";
  let observedAgentId = "";
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    observedAgentId = url.searchParams.get("agent_id") ?? "";
    observedKey = new Headers(init?.headers).get("xi-api-key") ?? "";
    return new Response(JSON.stringify({ signed_url: "wss://api.elevenlabs.io/mock-signed-session" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const app = createApp({ config, logger: createLogger(config), store, provider: new MockSmsProvider(), voiceRequest: request });
  const { baseUrl, server } = await listen(app);
  try {
    const health = await fetch(`${baseUrl}/health/voice`);
    assert.equal(health.status, 200);
    const response = await fetch(`${baseUrl}/api/voice/session`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      signedUrl: "wss://api.elevenlabs.io/mock-signed-session",
      expiresInSeconds: 900
    });
    assert.equal(observedKey, API_KEY);
    assert.equal(observedAgentId, AGENT_ID);
    assert.equal(JSON.stringify(await health.json()).includes(API_KEY), false);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("voice session endpoint rejects cross-origin and rate-limited requests", async () => {
  const config = makeConfig();
  const store = new SmsStore(":memory:", new CryptoBox(config.DATA_ENCRYPTION_KEY, config.PII_HASH_KEY));
  const request: typeof fetch = async () => new Response(
    JSON.stringify({ signed_url: "wss://api.elevenlabs.io/mock-signed-session" }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  const app = createApp({ config, logger: createLogger(config), store, provider: new MockSmsProvider(), voiceRequest: request });
  const { baseUrl, server } = await listen(app);
  try {
    const blocked = await fetch(`${baseUrl}/api/voice/session`, {
      method: "POST",
      headers: { origin: "https://attacker.invalid" }
    });
    assert.equal(blocked.status, 403);

    assert.equal((await fetch(`${baseUrl}/api/voice/session`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/voice/session`, { method: "POST" })).status, 200);
    const limited = await fetch(`${baseUrl}/api/voice/session`, { method: "POST" });
    assert.equal(limited.status, 429);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("backend root exposes no website or agent credential", async () => {
  const config = makeConfig();
  const store = new SmsStore(":memory:", new CryptoBox(config.DATA_ENCRYPTION_KEY, config.PII_HASH_KEY));
  const app = createApp({ config, logger: createLogger(config), store, provider: new MockSmsProvider() });
  const { baseUrl, server } = await listen(app);
  try {
    const response = await fetch(baseUrl);
    const body = await response.text();
    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(body), { ok: false, code: "NOT_FOUND" });
    assert.equal(body.includes(API_KEY), false);
    assert.equal(body.includes(AGENT_ID), false);
  } finally {
    await closeServer(server);
    store.close();
  }
});
