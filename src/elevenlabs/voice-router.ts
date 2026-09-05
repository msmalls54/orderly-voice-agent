import { Router, type Request } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";

const SignedUrlResponse = z.object({ signed_url: z.url() }).strict();
const MAX_TRACKED_VOICE_CLIENTS = 5_000;

interface VoiceRouterDependencies {
  config: AppConfig;
  logger: AppLogger;
  request?: typeof fetch;
  nowMs?: () => number;
}

function requestKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function isSameOrigin(req: Request): boolean {
  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return false;

  const origin = req.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.get("host") && parsed.protocol === `${req.protocol}:`;
  } catch {
    return false;
  }
}

export function createElevenLabsVoiceRouter(deps: VoiceRouterDependencies): Router {
  const router = Router();
  const request = deps.request ?? fetch;
  const nowMs = deps.nowMs ?? Date.now;
  const attempts = new Map<string, number[]>();

  router.get("/health/voice", (_req, res) => {
    const ready = Boolean(deps.config.ELEVENLABS_API_KEY && deps.config.ELEVENLABS_AGENT_ID);
    res.status(ready ? 200 : 503).json({
      ok: ready,
      provider: "elevenlabs",
      agentConfigured: Boolean(deps.config.ELEVENLABS_AGENT_ID),
      serverCredentialConfigured: Boolean(deps.config.ELEVENLABS_API_KEY),
      purchaseEnabled: false
    });
  });

  router.post("/api/voice/session", async (req, res) => {
    res.setHeader("cache-control", "no-store, max-age=0");
    res.setHeader("pragma", "no-cache");

    if (!isSameOrigin(req)) {
      res.status(403).json({ ok: false, code: "ORIGIN_NOT_ALLOWED" });
      return;
    }
    if (!deps.config.ELEVENLABS_API_KEY || !deps.config.ELEVENLABS_AGENT_ID) {
      res.status(503).json({ ok: false, code: "VOICE_NOT_CONFIGURED" });
      return;
    }

    const key = requestKey(req);
    const now = nowMs();
    const windowStart = now - deps.config.VOICE_SESSION_WINDOW_SECONDS * 1000;
    if (!attempts.has(key) && attempts.size >= MAX_TRACKED_VOICE_CLIENTS) {
      for (const [clientKey, timestamps] of attempts) {
        const active = timestamps.filter((timestamp) => timestamp > windowStart);
        if (active.length === 0) attempts.delete(clientKey);
        else attempts.set(clientKey, active);
        if (attempts.size < MAX_TRACKED_VOICE_CLIENTS) break;
      }
      if (attempts.size >= MAX_TRACKED_VOICE_CLIENTS) {
        const oldestKey = attempts.keys().next().value as string | undefined;
        if (oldestKey) attempts.delete(oldestKey);
      }
    }
    const recent = (attempts.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
    if (recent.length >= deps.config.VOICE_SESSION_LIMIT) {
      res.setHeader("retry-after", String(deps.config.VOICE_SESSION_WINDOW_SECONDS));
      res.status(429).json({ ok: false, code: "VOICE_SESSION_RATE_LIMITED" });
      return;
    }
    recent.push(now);
    attempts.set(key, recent);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const endpoint = new URL("/v1/convai/conversation/get-signed-url", deps.config.ELEVENLABS_API_BASE_URL);
      endpoint.searchParams.set("agent_id", deps.config.ELEVENLABS_AGENT_ID);
      const response = await request(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          "xi-api-key": deps.config.ELEVENLABS_API_KEY
        },
        signal: controller.signal
      });
      if (!response.ok) {
        deps.logger.warn({ event: "voice.signed_url_rejected", status: response.status }, "ElevenLabs rejected a signed-session request");
        res.status(502).json({ ok: false, code: "VOICE_PROVIDER_REJECTED" });
        return;
      }
      const parsed = SignedUrlResponse.safeParse(await response.json());
      if (!parsed.success) {
        deps.logger.warn({ event: "voice.signed_url_invalid_response" }, "ElevenLabs returned an invalid signed-session response");
        res.status(502).json({ ok: false, code: "VOICE_PROVIDER_INVALID_RESPONSE" });
        return;
      }
      res.status(200).json({ ok: true, signedUrl: parsed.data.signed_url, expiresInSeconds: 900 });
    } catch (error) {
      const code = error instanceof Error && error.name === "AbortError"
        ? "VOICE_PROVIDER_TIMEOUT"
        : "VOICE_PROVIDER_UNAVAILABLE";
      deps.logger.warn({ event: "voice.signed_url_failed", code }, "Could not create an ElevenLabs signed session");
      res.status(502).json({ ok: false, code });
    } finally {
      clearTimeout(timeout);
    }
  });

  return router;
}
