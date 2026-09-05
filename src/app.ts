import express, { type Express, type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import type { AppConfig } from "./config.js";
import { createElevenLabsVoiceRouter } from "./elevenlabs/voice-router.js";
import { createDoorDashHealthRouter } from "./doordash/health-router.js";
import type { AppLogger } from "./logger.js";
import type { SmsProvider, VoiceTurnHandler, WorkerHealth } from "./types.js";
import { SmsStore } from "./store/store.js";
import { createAgentPhoneWebhookRouter } from "./sms/webhook.js";

export interface ApplicationDependencies {
  config: AppConfig;
  logger: AppLogger;
  store: SmsStore;
  provider: SmsProvider;
  onInboundQueued?: () => void;
  nowMs?: () => number;
  workerHealth?: () => { inbound: WorkerHealth; outbound: WorkerHealth; enabled: boolean };
  voiceRequest?: typeof fetch;
  phoneVoiceHandler?: VoiceTurnHandler;
}

export function createApp(deps: ApplicationDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.config.TRUST_PROXY_HOPS);
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'", "https://unpkg.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        fontSrc: ["'self'", "data:", "https:"],
        mediaSrc: ["'self'", "blob:", "https:"],
        connectSrc: ["'self'", "https://*.elevenlabs.io", "wss://*.elevenlabs.io"],
        frameSrc: ["'self'", "https://*.elevenlabs.io"],
        upgradeInsecureRequests: []
      }
    }
  }));
  app.use((_req, res, next) => {
    res.setHeader("permissions-policy", "microphone=(self), camera=(), geolocation=()");
    next();
  });
  app.use(createAgentPhoneWebhookRouter({
    config: deps.config,
    logger: deps.logger,
    store: deps.store,
    ...(deps.onInboundQueued ? { onQueued: deps.onInboundQueued } : {}),
    ...(deps.phoneVoiceHandler ? { voiceHandler: deps.phoneVoiceHandler } : {}),
    ...(deps.nowMs ? { nowMs: deps.nowMs } : {})
  }));
  app.use(createElevenLabsVoiceRouter({
    config: deps.config,
    logger: deps.logger,
    ...(deps.voiceRequest ? { request: deps.voiceRequest } : {}),
    ...(deps.nowMs ? { nowMs: deps.nowMs } : {})
  }));
  app.use(createDoorDashHealthRouter(deps.config));

  app.get("/health/live", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/health/webhook", (_req, res) => {
    const ready = deps.provider.name === "mock" || Boolean(
      deps.config.AGENTPHONE_WEBHOOK_SECRET
      && deps.config.AGENTPHONE_AGENT_SEPARATION_CONFIRMED
      && deps.config.PUBLIC_WEBHOOK_URL?.startsWith("https://")
      && deps.config.AGENTPHONE_WEBHOOK_REMOTE_VERIFIED
    );
    res.status(ready ? 200 : 503).json({
      ok: ready,
      provider: deps.provider.name,
      signedWebhook: deps.provider.name === "mock" ? "simulated" : ready,
      voicePurchaseVerified: deps.config.VOICE_PURCHASE_VERIFIED
    });
  });

  app.get("/health/outbound", (_req, res) => {
    const ready = deps.provider.name === "mock" || Boolean(deps.config.LIVE_SMS_ENABLED && deps.config.SMS_OUTBOUND_VERIFIED);
    res.status(ready ? 200 : 503).json({
      ok: ready,
      provider: deps.provider.name,
      handsetRoundTripVerified: deps.provider.name === "mock" ? "simulated" : deps.config.SMS_OUTBOUND_VERIFIED
    });
  });

  app.get("/health/queue", (_req, res) => {
    const health = deps.store.queueHealth();
    const workers = deps.workerHealth?.();
    const ready = health.inboundFailed === 0
      && health.outboundFailed === 0
      && health.outboundAmbiguous === 0
      && health.failedAdminAlerts === 0
      && health.voiceFailed === 0
      && health.orderSubmissionsAmbiguous === 0
      && health.cartPreparationsUncertain === 0
      && (health.oldestInboundAgeSeconds === null || health.oldestInboundAgeSeconds <= deps.config.MAX_QUEUE_AGE_SECONDS)
      && (health.oldestOutboundAgeSeconds === null || health.oldestOutboundAgeSeconds <= deps.config.MAX_QUEUE_AGE_SECONDS)
      && (health.oldestVoiceAgeSeconds === null || health.oldestVoiceAgeSeconds <= deps.config.MAX_QUEUE_AGE_SECONDS)
      && (health.oldestOrderSubmissionAgeSeconds === null || health.oldestOrderSubmissionAgeSeconds <= deps.config.MAX_QUEUE_AGE_SECONDS)
      && (!workers?.enabled || (!workers.inbound.lastErrorCode && !workers.outbound.lastErrorCode));
    res.status(ready ? 200 : 503).json({ ok: ready, ...health, ...(workers ? { workers } : {}) });
  });

  app.get("/health", (_req, res) => {
    const queues = deps.store.queueHealth();
    const workers = deps.workerHealth?.();
    const webhookReady = deps.provider.name === "mock" || Boolean(
      deps.config.AGENTPHONE_WEBHOOK_SECRET
      && deps.config.AGENTPHONE_AGENT_SEPARATION_CONFIRMED
      && deps.config.PUBLIC_WEBHOOK_URL?.startsWith("https://")
      && deps.config.AGENTPHONE_WEBHOOK_REMOTE_VERIFIED
    );
    const outboundReady = deps.provider.name === "mock" || Boolean(deps.config.LIVE_SMS_ENABLED && deps.config.SMS_OUTBOUND_VERIFIED);
    const queuesReady = queues.inboundFailed === 0
      && queues.outboundFailed === 0
      && queues.outboundAmbiguous === 0
      && queues.failedAdminAlerts === 0
      && queues.voiceFailed === 0
      && queues.orderSubmissionsAmbiguous === 0
      && queues.cartPreparationsUncertain === 0
      && (queues.oldestInboundAgeSeconds === null || queues.oldestInboundAgeSeconds <= deps.config.MAX_QUEUE_AGE_SECONDS)
      && (queues.oldestOutboundAgeSeconds === null || queues.oldestOutboundAgeSeconds <= deps.config.MAX_QUEUE_AGE_SECONDS)
      && (queues.oldestVoiceAgeSeconds === null || queues.oldestVoiceAgeSeconds <= deps.config.MAX_QUEUE_AGE_SECONDS)
      && (queues.oldestOrderSubmissionAgeSeconds === null || queues.oldestOrderSubmissionAgeSeconds <= deps.config.MAX_QUEUE_AGE_SECONDS);
    const workersReady = !workers?.enabled || (!workers.inbound.lastErrorCode && !workers.outbound.lastErrorCode);
    const ok = webhookReady && outboundReady && queuesReady && workersReady;
    res.status(ok ? 200 : 503).json({
      ok,
      webhookReady,
      outboundReady,
      queuesReady,
      workersReady,
      queues,
      ...(workers ? { workers } : {})
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ ok: false, code: "NOT_FOUND" });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error({ event: "http.unhandled_error", errorName: error instanceof Error ? error.name : "UnknownError" }, "Unhandled request error");
    res.status(500).json({ ok: false, code: "INTERNAL_ERROR" });
  });
  return app;
}
