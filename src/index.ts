import { createServer } from "node:http";
import { AgentPhoneSmsProvider } from "./agentphone/client.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger, safeError } from "./logger.js";
import { MockSmsProvider } from "./mock/mock-provider.js";
import {
  MockOrderBackend,
  PhoneOrderCoordinator,
  PhoneOrderMessageHandler,
  PhoneOrderVoiceHandler
} from "./order/phone-order.js";
import { DoorDashCartBackend } from "./order/doordash-cart-backend.js";
import { CryptoBox } from "./security/crypto-box.js";
import { SmsStore } from "./store/store.js";
import { InboundWorker } from "./workers/inbound-worker.js";
import { WorkerLoop } from "./workers/loop.js";
import { OutboundWorker } from "./workers/outbound-worker.js";

const config = loadConfig();
const logger = createLogger(config);
const cryptoBox = new CryptoBox(config.DATA_ENCRYPTION_KEY, config.PII_HASH_KEY);
const store = new SmsStore(config.DATABASE_PATH, cryptoBox);
const recoveredPhoneActions = store.recoverInterruptedPhoneActions();
if (recoveredPhoneActions.voiceTurnsFailed > 0
  || recoveredPhoneActions.orderSubmissionsAmbiguous > 0
  || recoveredPhoneActions.cartChecksReleased > 0
  || recoveredPhoneActions.cartPreparationsUncertain > 0) {
  logger.warn({ event: "phone.actions_recovered", ...recoveredPhoneActions }, "Interrupted phone actions were placed into a safe hold");
}
const provider = config.SMS_PROVIDER === "agentphone"
  ? new AgentPhoneSmsProvider(config)
  : new MockSmsProvider();
const orderBackend = config.APP_MODE === "mock"
  ? new MockOrderBackend()
  : new DoorDashCartBackend(config, undefined, store);
const coordinator = new PhoneOrderCoordinator(store, orderBackend, config);
const handler = new PhoneOrderMessageHandler(coordinator);
const phoneVoiceHandler = new PhoneOrderVoiceHandler(coordinator);
const inboundWorker = new InboundWorker(store, handler, config, logger);
const outboundWorker = new OutboundWorker(store, provider, config, logger);
const workerError = (error: unknown) => logger.error({ event: "worker.loop_failed", error: safeError(error) }, "Worker loop failed");
const outboundLoop = new WorkerLoop(() => outboundWorker.runOnce(), config.WORKER_POLL_MS, workerError);
const inboundLoop = new WorkerLoop(async () => {
  const worked = await inboundWorker.runOnce();
  if (worked) outboundLoop.kick();
  return worked;
}, config.WORKER_POLL_MS, workerError);

const workersEnabled = provider.name === "mock" || config.LIVE_SMS_ENABLED;
const app = createApp({
  config,
  logger,
  store,
  provider,
  onInboundQueued: () => { if (workersEnabled) inboundLoop.kick(); },
  phoneVoiceHandler,
  workerHealth: () => ({ inbound: inboundLoop.health(), outbound: outboundLoop.health(), enabled: workersEnabled })
});
const server = createServer(app);
server.listen(config.PORT, "0.0.0.0", () => {
  logger.info({ event: "server.started", port: config.PORT, provider: provider.name }, "Orderly phone service started");
});
if (workersEnabled) {
  inboundLoop.start();
  outboundLoop.start();
} else {
  logger.warn({ event: "workers.paused", provider: provider.name }, "Inbound is stored but processing and outbound SMS are disabled");
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: "server.stopping", signal }, "Stopping Orderly phone service");
  await Promise.all([inboundLoop.stop(), outboundLoop.stop()]);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
