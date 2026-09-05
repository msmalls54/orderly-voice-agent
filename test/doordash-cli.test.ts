import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, type AppConfig } from "../src/config.js";
import { DoorDashCli, DoorDashCliError } from "../src/doordash/cli.js";

const KEY = Buffer.alloc(32, 4).toString("base64");

function config(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    SMS_PROVIDER: "mock",
    APP_MODE: "mock",
    LIVE_SMS_ENABLED: "false",
    SMS_OUTBOUND_VERIFIED: "false",
    ALLOWED_PHONES: "+14155550101",
    ADMIN_PHONE: "+14155550101",
    DATA_ENCRYPTION_KEY: KEY,
    PII_HASH_KEY: "fake-doordash-test-hash-key",
    DOORDASH_CLI_PATH: "/opt/dd-cli",
    DD_CLI_ACCESS_TOKEN: "fake-private-token",
    DOORDASH_DEMO_CART_UUID: "cart_abcdefgh",
    DOORDASH_PURCHASE_RUN_ID: "11111111-1111-4111-8111-111111111111",
    ...overrides
  });
}

test("DoorDash CLI runner pins commands, uses JSON, and passes the token only in the child environment", async () => {
  let file = "";
  let args: readonly string[] = [];
  let env: NodeJS.ProcessEnv = {};
  const cli = new DoorDashCli(config(), async (nextFile, nextArgs, options) => {
    file = nextFile;
    args = nextArgs;
    env = options.env;
    return { stdout: JSON.stringify({ orders: [] }), stderr: "" };
  });
  const result = await cli.history("Summary: Help the account owner order dinner\nuser prompt/purpose: \"reorder dinner\"");
  assert.deepEqual(result, { orders: [] });
  assert.equal(file.endsWith("dd-cli"), true);
  assert.deepEqual(args.slice(0, 5), ["--json-output", "order", "history", "--max", "10"]);
  assert.equal(args.includes("--intent"), true);
  assert.equal(args.includes("fake-private-token"), false);
  assert.equal(env["DD_CLI_ACCESS_TOKEN"], "fake-private-token");
  assert.equal(env["AGENTPHONE_API_KEY"], undefined);
});

test("DoorDash CLI version is exact and does not receive the access token", async () => {
  let env: NodeJS.ProcessEnv = {};
  const cli = new DoorDashCli(config(), async (_file, _args, options) => {
    env = options.env;
    return { stdout: "dd-cli-v0.2.4-linux-amd64, version 0.2.4\n", stderr: "" };
  });
  assert.equal(await cli.version(), "0.2.4");
  assert.equal(env["DD_CLI_ACCESS_TOKEN"], undefined);
});

test("DoorDash cart creation is fixed-shape and every office preview checks work benefits", async () => {
  const seen: string[][] = [];
  const cli = new DoorDashCli(config(), async (_file, args) => {
    seen.push([...args]);
    return { stdout: JSON.stringify({ structuredContent: {}, isError: false }), stderr: "" };
  });
  await cli.addItems("24749917", "19888350", [
    { itemId: "7495922921", itemName: "12 Regular Donut Holes", quantity: 1 },
    { itemId: "42280367358", itemName: "Apple Fritter", quantity: 2 }
  ], "Summary: Help the account owner prepare the supervised demo order\nuser prompt/purpose: \"order donuts\"");
  await cli.preview("cart_abcdefgh", "Summary: Help the account owner verify the supervised demo order\nuser prompt/purpose: \"preview donuts\"");

  const addArgs = seen[0] ?? [];
  const previewArgs = seen[1] ?? [];
  assert.deepEqual(addArgs.slice(0, 4), ["--json-output", "cart", "add-items", "--store-id"]);
  assert.equal(addArgs.includes("--fulfillment"), true);
  assert.equal(addArgs.includes("delivery"), true);
  const jsonIndex = addArgs.indexOf("--items-json");
  assert.deepEqual(JSON.parse(addArgs[jsonIndex + 1] ?? "null"), [
    { item_id: "7495922921", item_name: "12 Regular Donut Holes", quantity: 1 },
    { item_id: "42280367358", item_name: "Apple Fritter", quantity: 2 }
  ]);
  assert.equal(previewArgs.includes("--include-work-benefits"), true);
});

test("DoorDash preview and submit receive the same normalized schedule-ahead time", async () => {
  const seen: string[][] = [];
  const enabledConfig = config({
    SMS_PROVIDER: "agentphone",
    APP_MODE: "live",
    LIVE_SMS_ENABLED: "false",
    SMS_OUTBOUND_VERIFIED: "false",
    VOICE_PURCHASE_VERIFIED: "true",
    PURCHASE_ENABLED: "true",
    DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true",
    AGENTPHONE_AGENT_ID: "agt_test",
    AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    PUBLIC_WEBHOOK_URL: "https://example.invalid"
  });
  const cli = new DoorDashCli(enabledConfig, async (_file, args) => {
    seen.push([...args]);
    return { stdout: JSON.stringify({ structuredContent: {}, isError: false }), stderr: "" };
  });
  const supplied = "2099-09-05T12:30:00-07:00";
  const normalized = "2099-09-05T19:30:00.000Z";
  await cli.preview("cart_abcdefgh", "Summary: Preview the scheduled order safely", supplied);
  await cli.submit("cart_abcdefgh", 500, "Summary: Submit the scheduled approved order once", supplied);

  for (const args of seen) {
    const scheduleIndex = args.indexOf("--scheduled-time");
    assert.notEqual(scheduleIndex, -1);
    assert.equal(args[scheduleIndex + 1], normalized);
  }
  assert.equal(seen[1]?.includes("--yes"), true);
});

test("DoorDash submit is disabled independently of the model and mutation failures are ambiguous", async () => {
  const disabled = new DoorDashCli(config());
  await assert.rejects(
    async () => disabled.submit("cart_abcdefgh", 500, "Summary: Help the account owner order dinner\nuser prompt/purpose: \"place dinner\""),
    (error: unknown) => error instanceof DoorDashCliError && error.code === "PURCHASE_DISABLED" && !error.ambiguous
  );

  const enabledConfig = config({
    SMS_PROVIDER: "agentphone",
    APP_MODE: "live",
    LIVE_SMS_ENABLED: "true",
    SMS_OUTBOUND_VERIFIED: "true",
    PURCHASE_ENABLED: "true",
    DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true",
    AGENTPHONE_API_KEY: "fake-agentphone-key",
    AGENTPHONE_AGENT_ID: "agt_test",
    AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    PUBLIC_WEBHOOK_URL: "https://example.invalid"
  });
  const failing = new DoorDashCli(enabledConfig, async () => { throw new Error("private provider error"); });
  await assert.rejects(
    failing.submit("cart_abcdefgh", 500, "Summary: Help the account owner order dinner\nuser prompt/purpose: \"place dinner\""),
    (error: unknown) => error instanceof DoorDashCliError && error.code === "DOORDASH_MUTATION_OUTCOME_UNKNOWN" && error.ambiguous
  );
});
