import path from "node:path";

export const DEMO_AGENT_ID = "agt_orderly_demo";
export const DEMO_NUMBER_ID = "num_orderly_demo";
export const DEMO_SERVICE_PHONE = "+14155550103";
export const DEMO_USER_PHONE = "+14155550101";
export const DEMO_ADMIN_PHONE = "+14155550102";
export const DEMO_WEBHOOK_SECRET = "fake-orderly-webhook-secret-for-local-demo-only";

/**
 * Force the local demo onto fake identities and the mock provider even when
 * the parent shell contains live credentials. This entrypoint cannot send a
 * real SMS or reconfigure an AgentPhone webhook.
 */
export function applySafeDemoEnvironment(): void {
  process.env["SMS_PROVIDER"] = "mock";
  process.env["APP_MODE"] = "mock";
  process.env["LIVE_SMS_ENABLED"] = "false";
  process.env["SMS_OUTBOUND_VERIFIED"] = "false";
  process.env["PURCHASE_ENABLED"] = "false";
  process.env["DOORDASH_ACCOUNT_CONNECTED_VERIFIED"] = "false";
  delete process.env["DD_CLI_ACCESS_TOKEN"];
  delete process.env["DOORDASH_CLI_PATH"];
  delete process.env["AGENTPHONE_API_KEY"];
  process.env["AGENTPHONE_AGENT_ID"] = DEMO_AGENT_ID;
  process.env["AGENTPHONE_NUMBER_ID"] = DEMO_NUMBER_ID;
  process.env["AGENTPHONE_PHONE_NUMBER"] = DEMO_SERVICE_PHONE;
  process.env["AGENTPHONE_WEBHOOK_SECRET"] = DEMO_WEBHOOK_SECRET;
  process.env["PUBLIC_WEBHOOK_URL"] = "https://local-demo.invalid";
  process.env["AGENTPHONE_AGENT_SEPARATION_CONFIRMED"] = "false";
  process.env["AGENTPHONE_WEBHOOK_SETUP_ENABLED"] = "false";
  process.env["AGENTPHONE_WEBHOOK_REMOTE_VERIFIED"] = "false";
  process.env["ALLOWED_PHONES"] = `${DEMO_USER_PHONE},${DEMO_ADMIN_PHONE}`;
  process.env["ADMIN_PHONE"] = DEMO_ADMIN_PHONE;
  process.env["DATA_ENCRYPTION_KEY"] = Buffer.alloc(32, 17).toString("base64");
  process.env["PII_HASH_KEY"] = "fake-pii-hash-key-for-local-demo-only";
  process.env["DATABASE_PATH"] = process.env["ORDERLY_DEMO_DATABASE_PATH"]
    ?? path.resolve("./data/orderly-demo.db");
  process.env["LOG_LEVEL"] ??= "info";
}
