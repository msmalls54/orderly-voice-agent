import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, type AppConfig } from "../src/config.js";
import {
  DoorDashCartBackend,
  type CartPreparationGuard,
  type DoorDashCommands
} from "../src/order/doordash-cart-backend.js";

const CART = "cart_live_abcdefgh";

function config(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    SMS_PROVIDER: "mock",
    APP_MODE: "live_read_only",
    LIVE_SMS_ENABLED: "false",
    SMS_OUTBOUND_VERIFIED: "false",
    ALLOWED_PHONES: "+14155550101",
    ADMIN_PHONE: "+14155550101",
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    PII_HASH_KEY: "fake-orderly-backend-hash-key",
    DOORDASH_CLI_PATH: "/opt/dd-cli",
    DD_CLI_ACCESS_TOKEN: "fake-private-token",
    DOORDASH_ACCOUNT_CONNECTED_VERIFIED: "true",
    DOORDASH_DEMO_CART_UUID: CART,
    ...overrides
  });
}

function envelope(structuredContent: unknown): unknown {
  return { content: [], structuredContent, isError: false };
}

function cartGuard(): CartPreparationGuard & { status(): "checking" | "mutating" | "uncertain" | undefined } {
  let owner: string | undefined;
  let state: "checking" | "mutating" | "uncertain" | undefined;
  return {
    beginCartPreparation(attemptId) {
      if (state) return { status: state };
      owner = attemptId;
      state = "checking";
      return { status: "acquired" };
    },
    markCartPreparationMutating(attemptId) {
      if (owner !== attemptId || state !== "checking") return false;
      state = "mutating";
      return true;
    },
    releaseCartPreparation(attemptId, expectedStatus) {
      if (owner !== attemptId || state !== expectedStatus) return false;
      owner = undefined;
      state = undefined;
      return true;
    },
    holdCartPreparation(attemptId) {
      if (owner !== attemptId || (state !== "checking" && state !== "mutating")) return false;
      state = "uncertain";
      return true;
    },
    status: () => state
  };
}

function commands(overrides: Partial<DoorDashCommands> = {}): DoorDashCommands {
  return {
    listCarts: async () => envelope({ success: true, carts: [] }),
    addItems: async () => envelope({ success: true, cart_uuid: CART, item_errors: [] }),
    showCart: async () => envelope({
      success: true,
      cart_uuid: CART,
      cart: {
        id: CART,
        store_name: "My Happy Donut",
        items: [
          { id: "line_1", item_id: "7495922921", name: "12 Regular Donut Holes", quantity: 1 },
          { id: "line_2", item_id: "42280367358", name: "Apple Fritter", quantity: 2 }
        ]
      }
    }),
    preview: async () => envelope({
      success: true,
      cart_uuid: CART,
      quote: {
        store_order_cart: { is_consumer_pickup: false },
        delivery_address: { printable_address: "525 Market St, San Francisco, CA 94105", subpremise: "" },
        delivery_availability: {
          asap_available: true,
          asap_pickup_available: false,
          asap_minutes_range_string: "25-35 minutes",
          scheduled_delivery_available: true,
          available_days: [{
            day_timestamp: { year: 2099, month: 9, day: 5 },
            time_windows: [{
              display_string: "12:20 PM-12:40 PM",
              range_min: "2099-09-05T19:20:00.000Z",
              range_max: "2099-09-05T19:40:00.000Z",
              midpoint_timestamp: "2099-09-05T19:30:00.000Z"
            }]
          }]
        },
        net_total_before_tip: { unit_amount: 2000, display_string: "$20.00" },
        line_items: [
          { label: "Subtotal", charge_id: "SUBTOTAL", final_money: { unit_amount: 1680, display_string: "$16.80" } },
          { label: "Happy Hour", charge_id: "PROMOTION_DISCOUNT", final_money: { unit_amount: 504, display_string: "-$5.04" } },
          { label: "Taxes and fees", charge_id: "TAXES_AND_FEES", final_money: { unit_amount: 824, display_string: "$8.24" } }
        ],
        discount_banner_details: [{ promotion_id: "promo_happy_hour", discount_details_message: "30% off select items" }],
        promotions: [{ campaign_id: "promo_happy_hour", title: "Happy Hour: 30% off select items" }],
        tips_suggestion_details: [{
          default_index: 1,
          monetary_values: [
            { unit_amount: 300, display_string: "$3.00" },
            { unit_amount: 400, display_string: "$4.00" }
          ]
        }],
        contains_alcohol_item: false,
        min_age_requirement: 0
      }
    }),
    paymentMethods: async () => envelope({
      success: true,
      default_payment_method_id: "pm_1",
      cards: [{ payment_method_id: "pm_1", last4: "1111", brand: "Visa" }]
    }),
    submit: async () => envelope({ success: true, order_uuid: "order_abcdefgh", status: "pending" }),
    status: async () => envelope({
      success: true,
      result: { status: "placed", status_message: "Your order was placed.", merchant_name: "Test Kitchen" }
    }),
    ...overrides
  };
}

test("live cart backend produces a hashed exact-total preview and refreshes it", async () => {
  const backend = new DoorDashCartBackend(config(), commands());
  const first = await backend.prepareReorder({ request: "Order 12 regular donut holes and two apple fritters from My Happy Donut with a tip of $5", intent: "authorized test intent" });
  assert.equal(first.providerMode, "live");
  assert.equal(first.totalCents, 2500);
  assert.equal(first.tipCents, 500);
  assert.equal(first.paymentSummary, "Visa ending 1111");
  assert.equal(first.etaSummary, "25-35 minutes");
  assert.match(first.priceBreakdown ?? "", /Happy Hour -\$5\.04/);
  assert.match(first.promotionSummary ?? "", /Happy Hour: 30% off select items/);
  assert.match(first.providerSnapshotHash ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await backend.refreshPreview(first), first);
});

test("scheduled delivery is bound to preview, refresh, provider hash, and submit", async () => {
  const schedule = "2099-09-05T19:30:00.000Z";
  const previewSchedules: Array<string | undefined> = [];
  const submitSchedules: Array<string | undefined> = [];
  const scheduledCommands = commands({
    preview: async (_cartUuid, _intent, scheduledTime) => {
      previewSchedules.push(scheduledTime);
      const base = commands();
      return base.preview(CART, "authorized test intent");
    },
    submit: async (_cartUuid, _tipCents, _intent, scheduledTime) => {
      submitSchedules.push(scheduledTime);
      return envelope({ success: true, order_uuid: "order_scheduled_abcdefgh", status: "scheduled" });
    }
  });
  const backend = new DoorDashCartBackend(
    config({ DOORDASH_SCHEDULED_TIME: "2099-09-05T12:30:00-07:00" }),
    scheduledCommands,
    undefined,
    () => new Date("2099-09-04T19:30:00.000Z")
  );
  const first = await backend.prepareReorder({ request: "Get me the donuts tomorrow", intent: "authorized test intent" });
  assert.equal(first.scheduledTime, schedule);
  assert.match(first.providerSnapshotHash ?? "", /^sha256:[a-f0-9]{64}$/);
  const refreshed = await backend.refreshPreview(first);
  assert.equal(refreshed.scheduledTime, schedule);
  assert.equal(first.providerSnapshotHash, refreshed.providerSnapshotHash);
  const submitted = await backend.submit({ preview: refreshed, idempotencyKey: "sha256:scheduled-test" });
  assert.equal(submitted.status, "placed");
  assert.deepEqual(previewSchedules, [schedule, schedule]);
  assert.deepEqual(submitSchedules, [schedule]);

  const asap = await new DoorDashCartBackend(config(), commands()).prepareReorder({
    request: "Get me the donuts now",
    intent: "authorized test intent"
  });
  assert.notEqual(asap.providerSnapshotHash, first.providerSnapshotHash);
});

test("a scheduled preview can proceed without ASAP availability but a changed or stale schedule cannot submit", async () => {
  const schedule = "2099-09-05T19:30:00.000Z";
  let submits = 0;
  const noAsap = commands({
    preview: async () => envelope({
      success: true,
      cart_uuid: CART,
      quote: {
        store_order_cart: { is_consumer_pickup: false, fulfillment_type: "DELIVERY", invalid_items: [] },
        delivery_address: { printable_address: "525 Market St, 2nd Floor, San Francisco, CA 94105", address_id: "1762379937" },
        delivery_availability: {
          asap_available: false,
          asap_pickup_available: false,
          is_within_delivery_region: true,
          scheduled_delivery_available: true,
          available_days: [{
            day_timestamp: { year: 2099, month: 9, day: 5 },
            time_windows: [{
              display_string: "12:20 PM-12:40 PM",
              range_min: "2099-09-05T19:20:00.000Z",
              range_max: "2099-09-05T19:40:00.000Z",
              midpoint_timestamp: schedule
            }]
          }]
        },
        net_total_before_tip: { unit_amount: 2000, display_string: "$20.00" },
        line_items: [{ label: "Total before tip", final_money: { unit_amount: 2000, display_string: "$20.00" } }],
        tips_suggestion_details: [{ default_index: 0, monetary_values: [{ unit_amount: 400, display_string: "$4.00" }] }],
        contains_alcohol_item: false,
        min_age_requirement: 0
      }
    }),
    submit: async () => {
      submits += 1;
      return envelope({ success: true, order_uuid: "order_scheduled_abcdefgh", status: "scheduled" });
    }
  });
  const backend = new DoorDashCartBackend(
    config({ DOORDASH_SCHEDULED_TIME: schedule }),
    noAsap,
    undefined,
    () => new Date("2099-09-04T19:30:00.000Z")
  );
  const preview = await backend.prepareReorder({ request: "Get me the donuts tomorrow", intent: "authorized test intent" });
  await assert.rejects(
    backend.submit({ preview: { ...preview, scheduledTime: "2099-09-06T19:30:00.000Z" }, idempotencyKey: "sha256:changed-schedule" }),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_SCHEDULE_MISMATCH"
  );
  assert.equal(submits, 0);

  const stale = new DoorDashCartBackend(
    config({ DOORDASH_SCHEDULED_TIME: schedule }),
    noAsap,
    undefined,
    () => new Date("2099-09-05T19:30:00.000Z")
  );
  await assert.rejects(
    stale.prepareReorder({ request: "Get me the donuts tomorrow", intent: "authorized test intent" }),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_SCHEDULE_NOT_FUTURE"
  );
});

test("scheduled preview fails closed unless DoorDash offers the configured midpoint", async () => {
  const requested = "2099-09-05T19:00:00.000Z";
  const backend = new DoorDashCartBackend(
    config({ DOORDASH_SCHEDULED_TIME: requested }),
    commands(),
    undefined,
    () => new Date("2099-09-04T19:00:00.000Z")
  );
  await assert.rejects(
    backend.prepareReorder({ request: "Get me the donuts tomorrow at noon", intent: "authorized test intent" }),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_SCHEDULE_NOT_AVAILABLE"
  );
});

test("selected provider window fields are bound into the authorization hash", async () => {
  const schedule = "2099-09-05T19:30:00.000Z";
  const first = await new DoorDashCartBackend(
    config({ DOORDASH_SCHEDULED_TIME: schedule }),
    commands(),
    undefined,
    () => new Date("2099-09-04T19:30:00.000Z")
  ).prepareReorder({ request: "Get me the donuts tomorrow", intent: "authorized test intent" });
  const changedWindowCommands = commands({
    preview: async () => {
      const raw = await commands().preview(CART, "authorized test intent") as {
        structuredContent: { quote: { delivery_availability: { available_days: Array<{ time_windows: Array<{ display_string: string }> }> } } };
      };
      raw.structuredContent.quote.delivery_availability.available_days[0]!.time_windows[0]!.display_string = "12:15 PM-12:45 PM";
      return raw;
    }
  });
  const changed = await new DoorDashCartBackend(
    config({ DOORDASH_SCHEDULED_TIME: schedule }),
    changedWindowCommands,
    undefined,
    () => new Date("2099-09-04T19:30:00.000Z")
  ).prepareReorder({ request: "Get me the donuts tomorrow", intent: "authorized test intent" });
  assert.notEqual(changed.providerSnapshotHash, first.providerSnapshotHash);
});

test("configured fixed cart accepts meaningful request fragments while dynamic creation remains strict", async () => {
  const requests = [
    "Twelve donut holes and two apple fritters, please.",
    "From My Happy Donut, please.",
    "Please use the donut cart we already prepared."
  ];
  const configured = new DoorDashCartBackend(config(), commands());
  for (const request of requests) {
    const preview = await configured.prepareReorder({ request, intent: "authorized test intent" });
    assert.equal(preview.cartRef, CART);
  }

  let lists = 0;
  let adds = 0;
  const dynamic = new DoorDashCartBackend(config({ DOORDASH_DEMO_CART_UUID: "" }), commands({
    listCarts: async () => {
      lists += 1;
      return envelope({ success: true, carts: [] });
    },
    addItems: async () => {
      adds += 1;
      return envelope({ success: true, cart_uuid: CART, item_errors: [] });
    }
  }), cartGuard());
  for (const request of requests) {
    await assert.rejects(
      dynamic.prepareReorder({ request, intent: "authorized test intent" }),
      (error: unknown) => (error as { code?: string }).code === "ORDERLY_DEMO_REQUEST_UNSUPPORTED"
    );
  }
  assert.equal(lists, 0);
  assert.equal(adds, 0);
});

test("live cart backend rejects invalid items before approval", async () => {
  const bad = commands({
    preview: async () => envelope({
      success: true,
      cart_uuid: CART,
      quote: {
        store_order_cart: { is_consumer_pickup: false, invalid_items: [{ name: "Unavailable item" }] },
        delivery_address: { printable_address: "Home" },
        delivery_availability: { asap_available: true, asap_pickup_available: false },
        net_total_before_tip: { unit_amount: 2000, display_string: "$20.00" },
        line_items: [{ label: "Total before tip", final_money: { unit_amount: 2000, display_string: "$20.00" } }],
        tips_suggestion_details: [{
          default_index: 0,
          percentage_to_amount_monetary_values: [{ unit_amount: 400, display_string: "$4.00" }]
        }]
      }
    })
  });
  const backend = new DoorDashCartBackend(config(), bad);
  await assert.rejects(
    backend.prepareReorder({ request: "Order 12 regular donut holes and two apple fritters from My Happy Donut", intent: "authorized test intent" }),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_CART_HAS_INVALID_ITEMS"
  );
});

test("submit returns pending once and status maps placed", async () => {
  let submits = 0;
  const backend = new DoorDashCartBackend(config(), commands({
    submit: async () => {
      submits += 1;
      return envelope({ success: true, order_uuid: "order_abcdefgh", status: "pending" });
    }
  }));
  const preview = await backend.prepareReorder({ request: "Order 12 regular donut holes and two apple fritters from My Happy Donut with a $3 tip", intent: "authorized test intent" });
  const pending = await backend.submit({ preview, idempotencyKey: "sha256:test" });
  assert.equal(pending.status, "pending");
  assert.equal(submits, 1);
  assert.equal((await backend.status("order_abcdefgh")).status, "placed");
});

test("exact spoken request creates one fixed cart only after an empty-cart preflight", async () => {
  const calls: string[] = [];
  const backend = new DoorDashCartBackend(config({ DOORDASH_DEMO_CART_UUID: "" }), commands({
    listCarts: async (storeId) => {
      calls.push(`list:${storeId}`);
      return envelope({ success: true, carts: [] });
    },
    addItems: async (storeId, menuId, items) => {
      calls.push(`add:${storeId}:${menuId}`);
      assert.deepEqual(items, [
        { itemId: "7495922921", itemName: "12 Regular Donut Holes", quantity: 1 },
        { itemId: "42280367358", itemName: "Apple Fritter", quantity: 2 }
      ]);
      return envelope({ success: true, cart_uuid: CART, item_errors: [] });
    }
  }), cartGuard());
  const preview = await backend.prepareReorder({
    request: "Please order twelve donut holes and 2 apple fritters from My Happy Donut.",
    intent: "authorized test intent"
  });
  assert.equal(preview.cartRef, CART);
  assert.deepEqual(calls, ["list:24749917", "add:24749917:19888350"]);
});

test("unsupported basket and pre-existing cart both fail before additive cart mutation", async () => {
  let lists = 0;
  let adds = 0;
  const dynamic = new DoorDashCartBackend(config({ DOORDASH_DEMO_CART_UUID: "" }), commands({
    listCarts: async () => {
      lists += 1;
      return envelope({ success: true, carts: [{ cart_uuid: "other_cart_123" }] });
    },
    addItems: async () => {
      adds += 1;
      return envelope({ success: true, cart_uuid: CART, item_errors: [] });
    }
  }), cartGuard());
  for (const request of [
    "Order a salad",
    "Do not order 12 donut holes and two apple fritters from My Happy Donut",
    "Order 12 donut holes and two apple fritters plus bagels from My Happy Donut",
    "Order 12 donut holes and two apple fritters from Dunkin",
    "Order two dozen donut holes and two apple fritters from My Happy Donut",
    "Order 12 mixed donut holes and two apple fritters from My Happy Donut",
    "Order 12 donut holes and two apple fritters from My Happy Donut. Add bagels."
  ]) {
    await assert.rejects(
      dynamic.prepareReorder({ request, intent: "authorized test intent" }),
      (error: unknown) => (error as { code?: string }).code === "ORDERLY_DEMO_REQUEST_UNSUPPORTED"
    );
  }
  assert.equal(lists, 0);
  await assert.rejects(
    dynamic.prepareReorder({ request: "Order 12 donut holes and two apple fritters from My Happy Donut", intent: "authorized test intent" }),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_EXISTING_CART_REQUIRES_REVIEW"
  );
  assert.equal(lists, 1);
  assert.equal(adds, 0);
});

test("a durable preparation guard permits only one concurrent additive cart mutation", async () => {
  const guard = cartGuard();
  let releaseList!: () => void;
  let reportListStarted!: () => void;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  const listStarted = new Promise<void>((resolve) => { reportListStarted = resolve; });
  let lists = 0;
  let adds = 0;
  const sharedCommands = commands({
    listCarts: async () => {
      lists += 1;
      reportListStarted();
      await listGate;
      return envelope({ success: true, carts: [] });
    },
    addItems: async () => {
      adds += 1;
      return envelope({ success: true, cart_uuid: CART, item_errors: [] });
    }
  });
  const firstBackend = new DoorDashCartBackend(config({ DOORDASH_DEMO_CART_UUID: "" }), sharedCommands, guard);
  const secondBackend = new DoorDashCartBackend(config({ DOORDASH_DEMO_CART_UUID: "" }), sharedCommands, guard);
  const request = { request: "Order 12 donut holes and two apple fritters from My Happy Donut", intent: "authorized test intent" };
  const first = firstBackend.prepareReorder(request);
  await listStarted;
  await assert.rejects(
    secondBackend.prepareReorder(request),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_CART_PREPARATION_IN_PROGRESS"
  );
  releaseList();
  assert.equal((await first).cartRef, CART);
  assert.equal(lists, 1);
  assert.equal(adds, 1);
  assert.equal(guard.status(), undefined);
});

test("a post-add validation failure holds preparation as uncertain and blocks retries", async () => {
  const guard = cartGuard();
  let lists = 0;
  let adds = 0;
  const backend = new DoorDashCartBackend(config({ DOORDASH_DEMO_CART_UUID: "" }), commands({
    listCarts: async () => {
      lists += 1;
      return envelope({ success: true, carts: [] });
    },
    addItems: async () => {
      adds += 1;
      return envelope({ success: true, cart_uuid: CART, item_errors: [] });
    },
    showCart: async () => envelope({
      success: true,
      cart_uuid: CART,
      cart: {
        id: CART,
        store_name: "My Happy Donut",
        items: [{ id: "line_wrong", item_id: "7495922921", name: "12 Regular Donut Holes", quantity: 1 }]
      }
    })
  }), guard);
  const request = { request: "Order 12 donut holes and two apple fritters from My Happy Donut", intent: "authorized test intent" };
  await assert.rejects(
    backend.prepareReorder(request),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_CART_CONTENT_MISMATCH"
  );
  assert.equal(guard.status(), "uncertain");
  await assert.rejects(
    backend.prepareReorder(request),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_CART_PREPARATION_UNCERTAIN"
  );
  assert.equal(lists, 1);
  assert.equal(adds, 1);
});

test("a read-only cart preflight failure releases the preparation guard for a safe retry", async () => {
  const guard = cartGuard();
  let lists = 0;
  const backend = new DoorDashCartBackend(config({ DOORDASH_DEMO_CART_UUID: "" }), commands({
    listCarts: async () => {
      lists += 1;
      if (lists === 1) throw new Error("temporary read failure");
      return envelope({ success: true, carts: [] });
    }
  }), guard);
  const request = { request: "Order 12 donut holes and two apple fritters from My Happy Donut", intent: "authorized test intent" };
  await assert.rejects(
    backend.prepareReorder(request),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_CART_PREFLIGHT_FAILED"
  );
  assert.equal(guard.status(), undefined);
  assert.equal((await backend.prepareReorder(request)).cartRef, CART);
  assert.equal(lists, 2);
});

test("decimal tip requests tolerate normal sentence punctuation", async () => {
  const backend = new DoorDashCartBackend(config(), commands());
  const preview = await backend.prepareReorder({
    request: "Order 12 donut holes and two apple fritters from My Happy Donut with a $3.50 tip.",
    intent: "authorized test intent"
  });
  assert.equal(preview.tipCents, 350);
  assert.equal(preview.totalCents, 2350);
});

test("status without an explicit terminal result remains pending and never implies decline", async () => {
  const backend = new DoorDashCartBackend(config(), commands({
    status: async () => envelope({ success: false, message: "not ready" })
  }));
  const status = await backend.status("order_abcdefgh");
  assert.equal(status.status, "pending");
  assert.equal(status.orderRef, "order_abcdefgh");
  assert.match(status.safeSummary, /will not submit again/i);
});

test("live preview rejects the wrong floor, pickup, and unavailable delivery", async () => {
  const request = { request: "Order 12 donut holes and two apple fritters from My Happy Donut", intent: "authorized test intent" };
  const preview = (address: string, isPickup: boolean, asapAvailable: boolean) => envelope({
    success: true,
    cart_uuid: CART,
    quote: {
      store_order_cart: { is_consumer_pickup: isPickup, fulfillment_type: isPickup ? "PICKUP" : "DELIVERY", invalid_items: [] },
      delivery_address: { printable_address: address, address_id: "1762379937" },
      delivery_availability: { asap_available: asapAvailable, asap_pickup_available: true },
      net_total_before_tip: { unit_amount: 2000, display_string: "$20.00" },
      line_items: [{ label: "Total before tip", final_money: { unit_amount: 2000, display_string: "$20.00" } }],
      tips_suggestion_details: [{ default_index: 0, percentage_to_amount_monetary_values: [{ unit_amount: 400, display_string: "$4.00" }] }],
      contains_alcohol_item: false,
      min_age_requirement: 0
    }
  });
  const cases = [
    {
      raw: preview("525 Market St, 3rd Floor, San Francisco, CA 94105", false, true),
      code: "DOORDASH_DELIVERY_ADDRESS_MISMATCH"
    },
    {
      raw: preview("525 Market St, Floor 3, San Francisco, CA 94105", false, true),
      code: "DOORDASH_DELIVERY_ADDRESS_MISMATCH"
    },
    {
      raw: preview("525 Market St, 3rd Fl, San Francisco, CA 94105", false, true),
      code: "DOORDASH_DELIVERY_ADDRESS_MISMATCH"
    },
    {
      raw: preview("525 Market St, Suite 300, San Francisco, CA 94105", false, true),
      code: "DOORDASH_DELIVERY_ADDRESS_MISMATCH"
    },
    {
      raw: preview("525 Market St, 2nd Floor, San Francisco, CA 94105", true, true),
      code: "DOORDASH_FULFILLMENT_MISMATCH"
    },
    {
      raw: preview("525 Market St, 2nd Floor, San Francisco, CA 94105", false, false),
      code: "DOORDASH_ASAP_UNAVAILABLE"
    }
  ];
  for (const testCase of cases) {
    const backend = new DoorDashCartBackend(config(), commands({ preview: async () => testCase.raw }));
    await assert.rejects(
      backend.prepareReorder(request),
      (error: unknown) => (error as { code?: string }).code === testCase.code
    );
  }
});

test("cart validation rejects renamed items and unexpected customizations", async () => {
  const request = { request: "Order 12 donut holes and two apple fritters from My Happy Donut", intent: "authorized test intent" };
  const cart = (name: string, nestedOptions: unknown[]) => envelope({
    success: true,
    cart_uuid: CART,
    cart: {
      id: CART,
      store_id: "24749917",
      store_name: "My Happy Donut",
      items: [
        { id: "line_1", item_id: "7495922921", name, quantity: 1, nested_options: nestedOptions },
        { id: "line_2", item_id: "42280367358", name: "Apple Fritter", quantity: 2, nested_options: [] }
      ]
    }
  });
  for (const raw of [
    cart("Different Donut Holes", []),
    cart("12 Regular Donut Holes", [{ id: "unexpected", name: "Unexpected", quantity: 1 }])
  ]) {
    const backend = new DoorDashCartBackend(config(), commands({ showCart: async () => raw }));
    await assert.rejects(
      backend.prepareReorder(request),
      (error: unknown) => (error as { code?: string }).code === "DOORDASH_CART_CONTENT_MISMATCH"
    );
  }
});

test("volatile quote metadata and ETA do not change the authorization snapshot", async () => {
  let reads = 0;
  const backend = new DoorDashCartBackend(config(), commands({
    preview: async () => {
      reads += 1;
      return envelope({
        success: true,
        cart_uuid: CART,
        quote: {
          quote_id: `volatile_${reads}`,
          generated_at: `2026-09-04T20:00:0${reads}Z`,
          store_order_cart: { is_consumer_pickup: false, fulfillment_type: "DELIVERY", invalid_items: [] },
          delivery_address: {
            printable_address: "525 Market St, 2nd Floor, San Francisco, CA 94105",
            address_id: "1762379937"
          },
          delivery_availability: {
            asap_available: true,
            asap_pickup_available: false,
            asap_minutes_range_string: reads === 1 ? "20-30 minutes" : "21-31 minutes"
          },
          net_total_before_tip: { unit_amount: 2000, display_string: "$20.00" },
          line_items: [{ label: "Total before tip", final_money: { unit_amount: 2000, display_string: "$20.00" } }],
          tips_suggestion_details: [{ default_index: 0, percentage_to_amount_monetary_values: [{ unit_amount: 400, display_string: "$4.00" }] }],
          contains_alcohol_item: false,
          min_age_requirement: 0
        }
      });
    }
  }));
  const first = await backend.prepareReorder({
    request: "Order 12 donut holes and two apple fritters from My Happy Donut",
    intent: "authorized test intent"
  });
  const second = await backend.refreshPreview(first);
  assert.notEqual(first.etaSummary, second.etaSummary);
  assert.equal(first.providerSnapshotHash, second.providerSnapshotHash);
});

test("partial or ambiguous cart creation is never retried inside the backend", async () => {
  let partialAdds = 0;
  const partialGuard = cartGuard();
  const partial = new DoorDashCartBackend(config({ DOORDASH_DEMO_CART_UUID: "" }), commands({
    listCarts: async () => envelope({ success: true, carts: [] }),
    addItems: async () => {
      partialAdds += 1;
      return envelope({ success: false, cart_uuid: CART, item_errors: [{ error_message: "one item unavailable" }] });
    }
  }), partialGuard);
  await assert.rejects(
    partial.prepareReorder({ request: "Order 12 donut holes and two apple fritters from My Happy Donut", intent: "authorized test intent" }),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_CART_CREATION_UNCERTAIN"
  );
  assert.equal(partialAdds, 1);
  assert.equal(partialGuard.status(), "uncertain");

  let ambiguousAdds = 0;
  const ambiguousGuard = cartGuard();
  const ambiguous = new DoorDashCartBackend(config({ DOORDASH_DEMO_CART_UUID: "" }), commands({
    listCarts: async () => envelope({ success: true, carts: [] }),
    addItems: async () => {
      ambiguousAdds += 1;
      throw Object.assign(new Error("timeout"), { code: "DOORDASH_MUTATION_OUTCOME_UNKNOWN", ambiguous: true });
    }
  }), ambiguousGuard);
  await assert.rejects(
    ambiguous.prepareReorder({ request: "Order 12 donut holes and two apple fritters from My Happy Donut", intent: "authorized test intent" }),
    (error: unknown) => (error as { code?: string }).code === "DOORDASH_MUTATION_OUTCOME_UNKNOWN"
  );
  assert.equal(ambiguousAdds, 1);
  assert.equal(ambiguousGuard.status(), "uncertain");
});
