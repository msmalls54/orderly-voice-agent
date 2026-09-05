import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, type AppConfig } from "../src/config.js";
import {
  MockOrderBackend,
  PhoneOrderCoordinator,
  type OrderBackend,
  type OrderPreview,
  type OrderSubmission
} from "../src/order/phone-order.js";
import { isClearSpokenYes } from "../src/order/confirmation.js";
import { CryptoBox } from "../src/security/crypto-box.js";
import { SmsStore } from "../src/store/store.js";

const USER = "+14155550101";
const ADMIN = "+14155550102";
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
const PII_HASH_KEY = "phone-order-test-pii-hash-key";
const PURCHASE_RUN_ID = "11111111-1111-4111-8111-111111111111";

test("spoken yes accepts bounded ASR variants and rejects ambiguity or changes", () => {
  for (const phrase of [
    "Yes",
    "Yes, please.",
    "Yeah.",
    "Yep!",
    "Yes, go ahead.",
    "Okay, place the order.",
    "That's correct.",
    "Please do it."
  ]) {
    assert.equal(isClearSpokenYes(phrase), true, phrase);
  }
  for (const phrase of [
    "Yes, but change it",
    "Not yet",
    "I guess",
    "Maybe",
    "Yes, cancel",
    "Sure, use a different card",
    "Order something else"
  ]) {
    assert.equal(isClearSpokenYes(phrase), false, phrase);
  }
});

function config(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    SMS_PROVIDER: "mock",
    APP_MODE: "mock",
    LIVE_SMS_ENABLED: "false",
    SMS_OUTBOUND_VERIFIED: "false",
    ALLOWED_PHONES: `${USER},${ADMIN}`,
    ADMIN_PHONE: ADMIN,
    DATA_ENCRYPTION_KEY: ENCRYPTION_KEY,
    PII_HASH_KEY,
    DOORDASH_DEMO_CART_UUID: "cart_test_abcdefgh",
    DOORDASH_PURCHASE_RUN_ID: PURCHASE_RUN_ID,
    LOG_LEVEL: "fatal",
    ...overrides
  });
}

function store(): SmsStore {
  return new SmsStore(":memory:", new CryptoBox(ENCRYPTION_KEY, PII_HASH_KEY));
}

function fixedCartPreview(): OrderPreview {
  return {
    providerMode: "live",
    providerSnapshotHash: `sha256:${"c".repeat(64)}`,
    cartRef: "cart_live_fixed_voice",
    storeName: "My Happy Donut",
    itemSummary: "1 × 12 Regular Donut Holes, 2 × Apple Fritter",
    subtotalCents: 1651,
    feesCents: 0,
    taxCents: 0,
    tipCents: 250,
    creditsCents: 0,
    totalCents: 1901,
    addressSummary: "525 Market St, San Francisco, CA 94105",
    paymentSummary: "Visa ending 1111"
  };
}

test("voice and SMS share one mock order session and vague approval never confirms", async () => {
  const db = store();
  const backend = new MockOrderBackend();
  const coordinator = new PhoneOrderCoordinator(
    db,
    backend,
    config(),
    () => new Date("2026-09-03T20:00:00Z"),
    () => "4186"
  );
  try {
    const reset = await coordinator.handleTurn({
      deliveryId: "del_voice_reset",
      sender: USER,
      text: "Start over",
      channel: "voice"
    });
    assert.equal(reset.text, "Okay, starting over. What would you like to order?");
    const preview = await coordinator.handleTurn({
      deliveryId: "del_voice_preview",
      sender: USER,
      text: "Order what I had last Tuesday, but without onions.",
      channel: "voice"
    });
    assert.match(preview.text, /say yes now to confirm/i);
    assert.doesNotMatch(preview.text, /Confirm demo order 4186/);
    assert.match(preview.text, /\$26\.72/);

    const vague = await coordinator.handleTurn({
      deliveryId: "del_sms_vague",
      sender: USER,
      text: "Yeah, please.",
      channel: "sms"
    });
    assert.match(vague.text, /cannot accept a general yes/i);
    assert.match(vague.text, /Confirm demo order 4186/);

    const exact = await coordinator.handleTurn({
      deliveryId: "del_voice_exact",
      sender: USER,
      text: "Confirm demo order 4186.",
      channel: "voice"
    });
    assert.match(exact.text, /No real purchase was placed/);
    assert.equal(exact.hangup, true);
    assert.equal(backend.submitCalls, 0);
  } finally {
    db.close();
  }
});

test("confirmation expires and cannot call the backend", async () => {
  let now = new Date("2026-09-03T20:00:00Z");
  const db = store();
  const backend = new MockOrderBackend();
  const coordinator = new PhoneOrderCoordinator(db, backend, config(), () => now, () => "4186");
  try {
    await coordinator.handleTurn({ deliveryId: "del_preview", sender: USER, text: "reorder my last meal", channel: "sms" });
    now = new Date("2026-09-03T20:03:00Z");
    const result = await coordinator.handleTurn({
      deliveryId: "del_expired",
      sender: USER,
      text: "Confirm demo order 4186",
      channel: "voice"
    });
    assert.match(result.text, /expired/);
    assert.equal(backend.submitCalls, 0);
  } finally {
    db.close();
  }
});

test("start over accepts ordinary sentence punctuation", async () => {
  const db = store();
  const backend = new MockOrderBackend();
  const coordinator = new PhoneOrderCoordinator(db, backend, config(), undefined, () => "4186");
  try {
    await coordinator.handleTurn({
      deliveryId: "del_start_over_preview",
      sender: USER,
      text: "Reorder my last meal.",
      channel: "voice"
    });
    const result = await coordinator.handleTurn({
      deliveryId: "del_start_over_punctuation",
      sender: USER,
      text: "Start over.",
      channel: "voice"
    });
    assert.equal(result.text, "Okay, starting over. What would you like to order?");
    const state = JSON.parse(db.loadConversationState(USER)?.stateJson ?? "{}") as { stage?: string };
    assert.equal(state.stage, "ready");
    assert.equal(backend.submitCalls, 0);
  } finally {
    db.close();
  }
});

test("an expired preview reprocesses a fresh order request in the same turn", async () => {
  let now = new Date("2026-09-03T20:00:00Z");
  let prepares = 0;
  let submits = 0;
  const preview = fixedCartPreview();
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => {
      prepares += 1;
      return preview;
    },
    refreshPreview: async () => preview,
    submit: async () => {
      submits += 1;
      return { status: "placed", orderRef: "unused_order_ref", safeSummary: "unused" };
    }
  };
  const db = store();
  const coordinator = new PhoneOrderCoordinator(db, backend, config(), () => now, () => "4186");
  const request = "Order 12 regular donut holes and two apple fritters from My Happy Donut.";
  try {
    await coordinator.handleTurn({ deliveryId: "del_expired_fresh_first", sender: USER, text: request, channel: "voice" });
    now = new Date("2026-09-03T20:03:01Z");
    const result = await coordinator.handleTurn({ deliveryId: "del_expired_fresh_second", sender: USER, text: request, channel: "voice" });
    assert.match(result.text, /I found .*My Happy Donut/i);
    assert.match(result.text, /say yes now to confirm/i);
    assert.doesNotMatch(result.text, /expired/i);
    assert.equal(prepares, 2);
    assert.equal(submits, 0);
  } finally {
    db.close();
  }
});

test("a stale bare yes never starts a preview", async () => {
  let prepares = 0;
  let submits = 0;
  const preview = fixedCartPreview();
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => {
      prepares += 1;
      return preview;
    },
    refreshPreview: async () => preview,
    submit: async () => {
      submits += 1;
      return { status: "placed", orderRef: "unused_order_ref", safeSummary: "unused" };
    }
  };
  const db = store();
  const coordinator = new PhoneOrderCoordinator(db, backend, config());
  try {
    const result = await coordinator.handleTurn({
      deliveryId: "del_stale_bare_yes",
      sender: USER,
      text: "Yes.",
      channel: "voice"
    });
    assert.match(result.text, /active checkout|what would you like to order/i);
    assert.doesNotMatch(result.text, /I found/i);
    assert.equal(prepares, 0);
    assert.equal(submits, 0);
  } finally {
    db.close();
  }
});

test("a partial fixed-cart request while ready reaches preview", async () => {
  let prepares = 0;
  const preview = fixedCartPreview();
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => {
      prepares += 1;
      return preview;
    },
    refreshPreview: async () => preview,
    submit: async () => ({ status: "placed", orderRef: "unused_order_ref", safeSummary: "unused" })
  };
  const db = store();
  const coordinator = new PhoneOrderCoordinator(db, backend, config(), undefined, () => "4186");
  try {
    const result = await coordinator.handleTurn({
      deliveryId: "del_partial_fixed_cart_request",
      sender: USER,
      text: "Order the donut holes.",
      channel: "voice"
    });
    assert.match(result.text, /I found .*My Happy Donut/i);
    assert.match(result.text, /say yes now to confirm/i);
    assert.equal(prepares, 1);
  } finally {
    db.close();
  }
});

test("a repeated request while awaiting confirmation keeps the same preview and never submits", async () => {
  let prepares = 0;
  let submits = 0;
  const preview = fixedCartPreview();
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => {
      prepares += 1;
      return preview;
    },
    refreshPreview: async () => preview,
    submit: async () => {
      submits += 1;
      return { status: "placed", orderRef: "unused_order_ref", safeSummary: "unused" };
    }
  };
  const db = store();
  const coordinator = new PhoneOrderCoordinator(db, backend, config(), undefined, () => "4186");
  const request = "Order the donut holes.";
  try {
    await coordinator.handleTurn({ deliveryId: "del_repeat_request_first", sender: USER, text: request, channel: "voice" });
    const before = JSON.parse(db.loadConversationState(USER)?.stateJson ?? "{}") as { stage?: string; previewHash?: string };
    const repeated = await coordinator.handleTurn({ deliveryId: "del_repeat_request_second", sender: USER, text: request, channel: "voice" });
    const after = JSON.parse(db.loadConversationState(USER)?.stateJson ?? "{}") as { stage?: string; previewHash?: string };
    assert.match(repeated.text, /yes/i);
    assert.equal(prepares, 1);
    assert.equal(submits, 0);
    assert.equal(before.stage, "awaiting_confirmation");
    assert.equal(after.stage, "awaiting_confirmation");
    assert.equal(after.previewHash, before.previewHash);
  } finally {
    db.close();
  }
});

test("live purchase gate accepts one clear voice yes and a pending result is never resubmitted", async () => {
  const db = store();
  const preview: OrderPreview = {
    providerMode: "live",
    providerSnapshotHash: `sha256:${"1".repeat(64)}`,
    cartRef: "cart_live_test",
    storeName: "Test Kitchen",
    itemSummary: "one test bowl",
    subtotalCents: 1800,
    feesCents: 200,
    taxCents: 150,
    tipCents: 350,
    creditsCents: 0,
    totalCents: 2500,
    addressSummary: "Home",
    paymentSummary: "Visa ending 1111"
  };
  let submits = 0;
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => preview,
    refreshPreview: async () => preview,
    submit: async (): Promise<OrderSubmission> => {
      submits += 1;
      return { status: "pending", orderRef: "order_live_test", safeSummary: "DoorDash is processing the order." };
    },
    status: async () => ({ status: "pending", orderRef: "order_live_test", safeSummary: "DoorDash is still processing the order." })
  };
  const liveConfig = config({
    SMS_PROVIDER: "agentphone",
    APP_MODE: "live",
    LIVE_SMS_ENABLED: "true",
    SMS_OUTBOUND_VERIFIED: "true",
    PURCHASE_ENABLED: "true",
    DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true",
    DOORDASH_CLI_PATH: "/opt/dd-cli",
    DD_CLI_ACCESS_TOKEN: "fake-token",
    AGENTPHONE_API_KEY: "fake-key",
    AGENTPHONE_AGENT_ID: "agt_test",
    AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    PUBLIC_WEBHOOK_URL: "https://example.invalid"
  });
  const coordinator = new PhoneOrderCoordinator(
    db,
    backend,
    liveConfig,
    () => new Date("2026-09-03T20:00:00Z"),
    () => "4186"
  );
  try {
    const prepared = await coordinator.handleTurn({ deliveryId: "del_prepare", sender: USER, text: "reorder my last meal", channel: "voice" });
    assert.match(prepared.text, /say yes now to confirm/i);
    assert.doesNotMatch(prepared.text, /Place order 4186 for \$25\.00/);
    const first = await coordinator.handleTurn({ deliveryId: "del_confirm_voice", sender: USER, text: "Yes", channel: "voice" });
    assert.match(first.text, /processing/);
    const second = await coordinator.handleTurn({ deliveryId: "del_confirm_sms", sender: USER, text: "Place order 4186 for $25.00", channel: "sms" });
    assert.match(second.text, /still processing/);
    assert.equal(submits, 1);
    assert.equal(db.orderSubmissionCount(), 1);
  } finally {
    db.close();
  }
});

test("a pending submission reconciles to placed without a second submit", async () => {
  const db = store();
  const preview: OrderPreview = {
    providerMode: "live",
    providerSnapshotHash: `sha256:${"2".repeat(64)}`,
    cartRef: "cart_live_reconcile",
    storeName: "Test Kitchen",
    itemSummary: "one test bowl",
    subtotalCents: 1800,
    feesCents: 200,
    taxCents: 150,
    tipCents: 350,
    creditsCents: 0,
    totalCents: 2500,
    addressSummary: "Home",
    paymentSummary: "Visa ending 1111"
  };
  let submits = 0;
  let statusChecks = 0;
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => preview,
    refreshPreview: async () => preview,
    submit: async () => {
      submits += 1;
      return { status: "pending", orderRef: "order_live_reconcile", safeSummary: "DoorDash is processing the order." };
    },
    status: async () => {
      statusChecks += 1;
      return { status: "placed", orderRef: "order_live_reconcile", safeSummary: "DoorDash placed the order." };
    }
  };
  const liveConfig = config({
    SMS_PROVIDER: "agentphone",
    APP_MODE: "live",
    LIVE_SMS_ENABLED: "true",
    SMS_OUTBOUND_VERIFIED: "true",
    PURCHASE_ENABLED: "true",
    DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true",
    DOORDASH_CLI_PATH: "/opt/dd-cli",
    DD_CLI_ACCESS_TOKEN: "fake-token",
    AGENTPHONE_API_KEY: "fake-key",
    AGENTPHONE_AGENT_ID: "agt_test",
    AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    PUBLIC_WEBHOOK_URL: "https://example.invalid"
  });
  const coordinator = new PhoneOrderCoordinator(db, backend, liveConfig, () => new Date("2026-09-03T20:00:00Z"), () => "4186");
  try {
    await coordinator.handleTurn({ deliveryId: "del_prepare_reconcile", sender: USER, text: "reorder my last meal", channel: "voice" });
    const pending = await coordinator.handleTurn({ deliveryId: "del_confirm_reconcile", sender: USER, text: "Place order 4186 for $25.00", channel: "voice" });
    assert.match(pending.text, /processing/);
    const placed = await coordinator.handleTurn({ deliveryId: "del_status_reconcile", sender: USER, text: "what is the status", channel: "sms" });
    assert.match(placed.text, /placed/);
    assert.equal(placed.followUpSms, "DoorDash placed the order.");
    assert.equal(submits, 1);
    assert.equal(statusChecks, 1);

    const repeated = await coordinator.handleTurn({ deliveryId: "del_repeat_reconcile", sender: USER, text: "Place order 4186 for $25.00", channel: "voice" });
    assert.match(repeated.text, /placed/);
    assert.equal(submits, 1);
  } finally {
    db.close();
  }
});

test("cancel cannot erase a pending or placed order", async () => {
  const db = store();
  const preview: OrderPreview = {
    providerMode: "live",
    providerSnapshotHash: `sha256:${"3".repeat(64)}`,
    cartRef: "cart_live_cancel",
    storeName: "Test Kitchen",
    itemSummary: "one test bowl",
    subtotalCents: 1800,
    feesCents: 200,
    taxCents: 150,
    tipCents: 350,
    creditsCents: 0,
    totalCents: 2500,
    addressSummary: "Home",
    paymentSummary: "Visa ending 1111"
  };
  let status: OrderSubmission = { status: "pending", orderRef: "order_live_cancel", safeSummary: "DoorDash is still processing the order." };
  let submits = 0;
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => preview,
    refreshPreview: async () => preview,
    submit: async () => {
      submits += 1;
      return { status: "pending", orderRef: "order_live_cancel", safeSummary: "DoorDash is processing the order." };
    },
    status: async () => status
  };
  const liveConfig = config({
    SMS_PROVIDER: "agentphone", APP_MODE: "live", LIVE_SMS_ENABLED: "true", SMS_OUTBOUND_VERIFIED: "true",
    PURCHASE_ENABLED: "true", DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true", DOORDASH_CLI_PATH: "/opt/dd-cli",
    DD_CLI_ACCESS_TOKEN: "fake-token", AGENTPHONE_API_KEY: "fake-key", AGENTPHONE_AGENT_ID: "agt_test",
    AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret", AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    PUBLIC_WEBHOOK_URL: "https://example.invalid"
  });
  const coordinator = new PhoneOrderCoordinator(db, backend, liveConfig, () => new Date("2026-09-03T20:00:00Z"), () => "4186");
  try {
    await coordinator.handleTurn({ deliveryId: "del_prepare_cancel", sender: USER, text: "reorder my last meal", channel: "voice" });
    await coordinator.handleTurn({ deliveryId: "del_confirm_cancel", sender: USER, text: "Place order 4186 for $25.00", channel: "voice" });
    const pendingCancel = await coordinator.handleTurn({ deliveryId: "del_cancel_pending", sender: USER, text: "cancel", channel: "voice" });
    assert.match(pendingCancel.text, /still processing/);
    assert.doesNotMatch(pendingCancel.text, /nothing was purchased/i);
    status = { status: "placed", orderRef: "order_live_cancel", safeSummary: "DoorDash placed the order." };
    const placedCancel = await coordinator.handleTurn({ deliveryId: "del_cancel_placed", sender: USER, text: "cancel", channel: "voice" });
    assert.match(placedCancel.text, /placed/);
    assert.doesNotMatch(placedCancel.text, /nothing was purchased/i);
    assert.equal(submits, 1);
  } finally {
    db.close();
  }
});

test("a same-price cart mutation invalidates approval and does not submit", async () => {
  const db = store();
  const preview: OrderPreview = {
    providerMode: "live",
    providerSnapshotHash: `sha256:${"4".repeat(64)}`,
    cartRef: "cart_live_changed",
    storeName: "Test Kitchen",
    itemSummary: "one test bowl",
    subtotalCents: 1800, feesCents: 200, taxCents: 150, tipCents: 350, creditsCents: 0, totalCents: 2500,
    addressSummary: "Home", paymentSummary: "Visa ending 1111"
  };
  let submits = 0;
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => preview,
    refreshPreview: async () => ({ ...preview, providerSnapshotHash: `sha256:${"5".repeat(64)}`, itemSummary: "one different test bowl" }),
    submit: async () => { submits += 1; return { status: "placed", orderRef: "order_should_not_exist", safeSummary: "placed" }; }
  };
  const liveConfig = config({
    SMS_PROVIDER: "agentphone", APP_MODE: "live", LIVE_SMS_ENABLED: "true", SMS_OUTBOUND_VERIFIED: "true",
    PURCHASE_ENABLED: "true", DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true", DOORDASH_CLI_PATH: "/opt/dd-cli",
    DD_CLI_ACCESS_TOKEN: "fake-token", AGENTPHONE_API_KEY: "fake-key", AGENTPHONE_AGENT_ID: "agt_test",
    AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret", AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    PUBLIC_WEBHOOK_URL: "https://example.invalid"
  });
  const coordinator = new PhoneOrderCoordinator(db, backend, liveConfig, () => new Date("2026-09-03T20:00:00Z"), () => "4186");
  try {
    await coordinator.handleTurn({ deliveryId: "del_prepare_changed", sender: USER, text: "reorder my last meal", channel: "voice" });
    const result = await coordinator.handleTurn({ deliveryId: "del_confirm_changed", sender: USER, text: "Yes", channel: "voice" });
    assert.match(result.text, /old approval is invalid/i);
    assert.match(result.text, /one different test bowl/i);
    assert.match(result.text, /say yes/i);
    assert.equal(submits, 0);
  } finally {
    db.close();
  }
});

test("concurrent voice and SMS approval can call submit only once", async () => {
  const db = store();
  const preview: OrderPreview = {
    providerMode: "live", providerSnapshotHash: `sha256:${"6".repeat(64)}`, cartRef: "cart_live_race",
    storeName: "Test Kitchen", itemSummary: "one test bowl", subtotalCents: 1800, feesCents: 200, taxCents: 150,
    tipCents: 350, creditsCents: 0, totalCents: 2500, addressSummary: "Home", paymentSummary: "Visa ending 1111"
  };
  let submits = 0;
  const backend: OrderBackend = {
    mode: "live", prepareReorder: async () => preview, refreshPreview: async () => preview,
    submit: async () => {
      submits += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { status: "pending", orderRef: "order_live_race", safeSummary: "DoorDash is processing the order." };
    },
    status: async () => ({ status: "pending", orderRef: "order_live_race", safeSummary: "DoorDash is still processing the order." })
  };
  const liveConfig = config({
    SMS_PROVIDER: "agentphone", APP_MODE: "live", LIVE_SMS_ENABLED: "true", SMS_OUTBOUND_VERIFIED: "true",
    PURCHASE_ENABLED: "true", DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true", DOORDASH_CLI_PATH: "/opt/dd-cli",
    DD_CLI_ACCESS_TOKEN: "fake-token", AGENTPHONE_API_KEY: "fake-key", AGENTPHONE_AGENT_ID: "agt_test",
    AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret", AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    PUBLIC_WEBHOOK_URL: "https://example.invalid"
  });
  const coordinator = new PhoneOrderCoordinator(db, backend, liveConfig, () => new Date("2026-09-03T20:00:00Z"), () => "4186");
  try {
    await coordinator.handleTurn({ deliveryId: "del_prepare_race", sender: USER, text: "reorder my last meal", channel: "voice" });
    const results = await Promise.allSettled([
      coordinator.handleTurn({ deliveryId: "del_confirm_race_voice", sender: USER, text: "Place order 4186 for $25.00", channel: "voice" }),
      coordinator.handleTurn({ deliveryId: "del_confirm_race_sms", sender: USER, text: "Place order 4186 for $25.00", channel: "sms" })
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(submits, 1);
    assert.equal(db.orderSubmissionCount(), 1);
  } finally {
    db.close();
  }
});

test("the one-order ledger blocks concurrent approvals from different callers", async () => {
  const db = store();
  const preview: OrderPreview = {
    providerMode: "live", providerSnapshotHash: `sha256:${"7".repeat(64)}`, cartRef: "cart_live_global",
    storeName: "Test Kitchen", itemSummary: "one test bowl", subtotalCents: 1800, feesCents: 200, taxCents: 150,
    tipCents: 350, creditsCents: 0, totalCents: 2500, addressSummary: "Home", paymentSummary: "Visa ending 1111"
  };
  let submits = 0;
  const backend: OrderBackend = {
    mode: "live", prepareReorder: async () => preview, refreshPreview: async () => preview,
    submit: async () => {
      submits += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { status: "pending", orderRef: "order_live_global", safeSummary: "DoorDash is processing the order." };
    }
  };
  const liveConfig = config({
    SMS_PROVIDER: "agentphone", APP_MODE: "live", LIVE_SMS_ENABLED: "true", SMS_OUTBOUND_VERIFIED: "true",
    PURCHASE_ENABLED: "true", DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true", DOORDASH_CLI_PATH: "/opt/dd-cli",
    DD_CLI_ACCESS_TOKEN: "fake-token", AGENTPHONE_API_KEY: "fake-key", AGENTPHONE_AGENT_ID: "agt_test",
    AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret", AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    PUBLIC_WEBHOOK_URL: "https://example.invalid"
  });
  const coordinator = new PhoneOrderCoordinator(db, backend, liveConfig, () => new Date("2026-09-03T20:00:00Z"), () => "4186");
  try {
    await coordinator.handleTurn({ deliveryId: "del_prepare_user", sender: USER, text: "reorder my last meal", channel: "voice" });
    await coordinator.handleTurn({ deliveryId: "del_prepare_admin", sender: ADMIN, text: "reorder my last meal", channel: "voice" });
    const results = await Promise.allSettled([
      coordinator.handleTurn({ deliveryId: "del_confirm_user", sender: USER, text: "Place order 4186 for $25.00", channel: "voice" }),
      coordinator.handleTurn({ deliveryId: "del_confirm_admin", sender: ADMIN, text: "Place order 4186 for $25.00", channel: "voice" })
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(submits, 1);
    assert.equal(db.orderSubmissionCount(), 1);
  } finally {
    db.close();
  }
});

test("a fresh purchase-run ID permits one new scheduled order without erasing the first ledger", async () => {
  const db = store();
  const firstRunId = PURCHASE_RUN_ID;
  const secondRunId = "22222222-2222-4222-8222-222222222222";
  const liveGates = {
    SMS_PROVIDER: "agentphone",
    APP_MODE: "live",
    LIVE_SMS_ENABLED: "false",
    SMS_OUTBOUND_VERIFIED: "false",
    VOICE_PURCHASE_VERIFIED: "true",
    PURCHASE_ENABLED: "true",
    DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true",
    DOORDASH_CLI_PATH: "/opt/dd-cli",
    DD_CLI_ACCESS_TOKEN: "fake-token",
    AGENTPHONE_AGENT_ID: "agt_test",
    AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    PUBLIC_WEBHOOK_URL: "https://example.invalid"
  };
  const firstPreview = { ...fixedCartPreview(), cartRef: "cart_first_run" };
  const secondPreview = {
    ...fixedCartPreview(),
    cartRef: "cart_second_run",
    providerSnapshotHash: `sha256:${"d".repeat(64)}`,
    scheduledTime: "2099-09-05T19:30:00.000Z"
  };
  let firstSubmits = 0;
  let secondSubmits = 0;
  const firstBackend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => firstPreview,
    refreshPreview: async () => firstPreview,
    submit: async () => {
      firstSubmits += 1;
      return { status: "placed", orderRef: "order_first_run", safeSummary: "DoorDash placed the first order." };
    }
  };
  const secondBackend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => secondPreview,
    refreshPreview: async () => secondPreview,
    submit: async () => {
      secondSubmits += 1;
      return { status: "placed", orderRef: "order_second_run", safeSummary: "DoorDash scheduled the second order." };
    }
  };
  const now = () => new Date("2099-09-04T19:30:00.000Z");
  try {
    const first = new PhoneOrderCoordinator(db, firstBackend, config({ ...liveGates, DOORDASH_PURCHASE_RUN_ID: firstRunId }), now, () => "4186");
    await first.handleTurn({ deliveryId: "del_first_run_preview", sender: USER, text: "get me the donuts", channel: "voice" });
    assert.match((await first.handleTurn({ deliveryId: "del_first_run_confirm", sender: USER, text: "yes", channel: "voice" })).text, /first order/i);
    assert.equal(db.orderSubmissionCount(), 1);
    assert.equal(db.purchaseRunConsumed(firstRunId), true);

    const second = new PhoneOrderCoordinator(db, secondBackend, config({ ...liveGates, DOORDASH_PURCHASE_RUN_ID: secondRunId }), now, () => "5274");
    const scheduledReadback = await second.handleTurn({
      deliveryId: "del_second_run_preview",
      sender: USER,
      text: "get me the donuts tomorrow",
      channel: "voice",
      callId: "call_second_run"
    });
    assert.match(scheduledReadback.text, /September 5, 2099 at 12:30 PM PDT/i);
    assert.match((await second.handleTurn({ deliveryId: "del_second_run_confirm", sender: USER, text: "yes", channel: "voice" })).text, /scheduled the second order/i);
    assert.equal(firstSubmits, 1);
    assert.equal(secondSubmits, 1);
    assert.equal(db.orderSubmissionCount(), 2);
    assert.equal(db.purchaseRunConsumed(firstRunId), true);
    assert.equal(db.purchaseRunConsumed(secondRunId), true);

    const duplicateRun = await second.handleTurn({ deliveryId: "del_second_run_duplicate", sender: ADMIN, text: "get me the donuts", channel: "voice" });
    assert.match(duplicateRun.text, /purchase run is already consumed/i);
    assert.equal(secondSubmits, 1);
  } finally {
    db.close();
  }
});

test("changing only the scheduled delivery time invalidates the caller's approval", async () => {
  const db = store();
  const preview: OrderPreview = {
    ...fixedCartPreview(),
    scheduledTime: "2099-09-05T19:30:00.000Z"
  };
  let submits = 0;
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => preview,
    refreshPreview: async () => ({ ...preview, scheduledTime: "2099-09-05T20:30:00.000Z" }),
    submit: async () => {
      submits += 1;
      return { status: "placed", orderRef: "order_should_not_exist", safeSummary: "placed" };
    }
  };
  const liveConfig = config({
    SMS_PROVIDER: "agentphone", APP_MODE: "live", VOICE_PURCHASE_VERIFIED: "true", PURCHASE_ENABLED: "true",
    DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true", DOORDASH_CLI_PATH: "/opt/dd-cli", DD_CLI_ACCESS_TOKEN: "fake-token",
    AGENTPHONE_AGENT_ID: "agt_test", AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true", PUBLIC_WEBHOOK_URL: "https://example.invalid"
  });
  const coordinator = new PhoneOrderCoordinator(db, backend, liveConfig, () => new Date("2099-09-04T19:30:00.000Z"), () => "4186");
  try {
    const readback = await coordinator.handleTurn({ deliveryId: "del_schedule_preview", sender: USER, text: "get me the donuts tomorrow", channel: "voice" });
    assert.match(readback.text, /September 5, 2099 at 12:30 PM PDT/i);
    const changed = await coordinator.handleTurn({ deliveryId: "del_schedule_confirm", sender: USER, text: "yes", channel: "voice" });
    assert.match(changed.text, /old approval is invalid/i);
    assert.match(changed.text, /1:30 PM PDT/i);
    assert.equal(submits, 0);
  } finally {
    db.close();
  }
});

test("a maximum-length live preview always preserves the exact approval phrase", async () => {
  const db = store();
  const preview: OrderPreview = {
    providerMode: "live",
    providerSnapshotHash: `sha256:${"8".repeat(64)}`,
    cartRef: "cart_live_long_preview",
    storeName: "S".repeat(100),
    itemSummary: "I".repeat(500),
    subtotalCents: 1800,
    feesCents: 200,
    taxCents: 150,
    tipCents: 350,
    creditsCents: 0,
    totalCents: 2500,
    addressSummary: "A".repeat(100),
    paymentSummary: `Visa ending 1111 ${"P".repeat(80)}`.slice(0, 100),
    etaSummary: "E".repeat(100),
    priceBreakdown: "B".repeat(500),
    promotionSummary: "D".repeat(300),
    workBenefitSummary: "W".repeat(300),
    requiresPinHandoff: true
  };
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => preview,
    refreshPreview: async () => preview,
    submit: async () => ({ status: "placed", orderRef: "unused_order_ref", safeSummary: "unused" })
  };
  const coordinator = new PhoneOrderCoordinator(db, backend, config(), () => new Date("2026-09-03T20:00:00Z"), () => "4186");
  try {
    const result = await coordinator.handleTurn({ deliveryId: "del_long", sender: USER, text: "reorder my last meal", channel: "voice" });
    assert.equal(result.text.length <= 1150, true);
    assert.match(result.text, /and place order 4186 for \$25\.00 and accept PIN handoff\.$/);
  } finally {
    db.close();
  }
});

test("a PIN handoff requires the exact spoken phrase rather than a general yes", async () => {
  const db = store();
  const preview: OrderPreview = {
    providerMode: "live",
    providerSnapshotHash: `sha256:${"a".repeat(64)}`,
    cartRef: "cart_live_pin",
    storeName: "Test Kitchen",
    itemSummary: "one test bowl",
    subtotalCents: 1800,
    feesCents: 200,
    taxCents: 150,
    tipCents: 350,
    creditsCents: 0,
    totalCents: 2500,
    addressSummary: "Home",
    paymentSummary: "Visa ending 1111",
    requiresPinHandoff: true
  };
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => preview,
    refreshPreview: async () => preview,
    submit: async () => ({ status: "placed", orderRef: "unused_order_ref", safeSummary: "unused" })
  };
  const coordinator = new PhoneOrderCoordinator(db, backend, config(), () => new Date("2026-09-03T20:00:00Z"), () => "4186");
  try {
    const readback = await coordinator.handleTurn({ deliveryId: "del_pin_preview", sender: USER, text: "reorder my last meal", channel: "voice" });
    assert.doesNotMatch(readback.text, /say yes/i);
    const result = await coordinator.handleTurn({ deliveryId: "del_pin_yes", sender: USER, text: "Yes", channel: "voice" });
    assert.match(result.text, /did not approve/i);
    assert.match(result.text, /accept PIN handoff/i);
  } finally {
    db.close();
  }
});

test("a locked live checkout rehearsal never claims the preview is a mock order", async () => {
  const db = store();
  const preview: OrderPreview = {
    providerMode: "live",
    providerSnapshotHash: `sha256:${"9".repeat(64)}`,
    cartRef: "cart_live_rehearsal",
    storeName: "My Happy Donut",
    itemSummary: "12 regular donut holes and two apple fritters",
    subtotalCents: 1680,
    feesCents: 200,
    taxCents: 150,
    tipCents: 350,
    creditsCents: 0,
    totalCents: 2380,
    addressSummary: "AWS Builder Loft, 525 Market Street, second floor",
    paymentSummary: "Visa ending 1111"
  };
  const backend: OrderBackend = {
    mode: "live",
    prepareReorder: async () => preview,
    refreshPreview: async () => preview,
    submit: async () => ({ status: "placed", orderRef: "unused_order_ref", safeSummary: "unused" })
  };
  const coordinator = new PhoneOrderCoordinator(db, backend, config(), () => new Date("2026-09-03T20:00:00Z"), () => "4186");
  try {
    const readback = await coordinator.handleTurn({ deliveryId: "del_live_rehearsal_preview", sender: USER, text: "reorder my last meal", channel: "voice" });
    assert.equal(readback.text.length <= 500, true);
    assert.match(readback.text, /say yes now to confirm/i);
    assert.doesNotMatch(readback.text, /Place order 4186/i);
    const result = await coordinator.handleTurn({
      deliveryId: "del_live_rehearsal_confirm",
      sender: USER,
      text: "Yes",
      channel: "voice"
    });
    assert.equal(result.text, "Your live checkout preview was confirmed for rehearsal. No real purchase was placed.");
    assert.doesNotMatch(result.text, /mock/i);
    assert.equal(result.hangup, true);
  } finally {
    db.close();
  }
});

test("purchase configuration fails closed unless every live gate is present", () => {
  assert.throws(() => config({ PURCHASE_ENABLED: "true" }), /Purchasing requires/);
});

test("purchase configuration accepts either a verified voice path or the existing verified SMS path", () => {
  const commonLivePurchaseGates = {
    SMS_PROVIDER: "agentphone",
    APP_MODE: "live",
    PURCHASE_ENABLED: "true",
    DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true",
    DOORDASH_CLI_PATH: "/opt/dd-cli",
    DD_CLI_ACCESS_TOKEN: "fake-token",
    AGENTPHONE_AGENT_ID: "agt_test",
    AGENTPHONE_WEBHOOK_SECRET: "fake-webhook-secret",
    AGENTPHONE_AGENT_SEPARATION_CONFIRMED: "true",
    PUBLIC_WEBHOOK_URL: "https://example.invalid"
  };

  assert.doesNotThrow(() => config({
    ...commonLivePurchaseGates,
    VOICE_PURCHASE_VERIFIED: "true",
    LIVE_SMS_ENABLED: "false",
    SMS_OUTBOUND_VERIFIED: "false"
  }));

  assert.doesNotThrow(() => config({
    ...commonLivePurchaseGates,
    VOICE_PURCHASE_VERIFIED: "false",
    LIVE_SMS_ENABLED: "true",
    SMS_OUTBOUND_VERIFIED: "true",
    AGENTPHONE_API_KEY: "fake-key"
  }));

  assert.throws(() => config({
    ...commonLivePurchaseGates,
    VOICE_PURCHASE_VERIFIED: "false",
    LIVE_SMS_ENABLED: "false",
    SMS_OUTBOUND_VERIFIED: "false"
  }), /Purchasing requires/);

  assert.throws(() => config({
    ...commonLivePurchaseGates,
    VOICE_PURCHASE_VERIFIED: "true",
    DD_CLI_ACCESS_TOKEN: ""
  }), /DoorDash access token/);

  assert.throws(() => config({
    ...commonLivePurchaseGates,
    VOICE_PURCHASE_VERIFIED: "true",
    DOORDASH_PURCHASE_RUN_ID: ""
  }), /fresh immutable DoorDash purchase-run ID/);
});
