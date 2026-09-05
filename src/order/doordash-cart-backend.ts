import crypto from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { DoorDashCli, type DoorDashCartItemInput } from "../doordash/cli.js";
import type { OrderBackend, OrderPreview, OrderSubmission } from "./phone-order.js";

const DEMO_STORE_ID = "24749917";
const DEMO_MENU_ID = "19888350";
const DEMO_STORE_NAME = "My Happy Donut";
const DEMO_ADDRESS_ID = "1762379937";
const DEMO_ITEMS: readonly DoorDashCartItemInput[] = [
  { itemId: "7495922921", itemName: "12 Regular Donut Holes", quantity: 1 },
  { itemId: "42280367358", itemName: "Apple Fritter", quantity: 2 }
];

const EnvelopeSchema = z.object({
  structuredContent: z.unknown(),
  isError: z.boolean().optional()
}).passthrough();

const MoneySchema = z.object({
  unit_amount: z.number().int().nonnegative(),
  display_string: z.string().min(1)
}).passthrough();

const CartSchema = z.object({
  success: z.literal(true),
  cart_uuid: z.string().min(8).max(200),
  cart: z.object({
    id: z.string().min(8).max(200),
    store_id: z.union([z.string(), z.number()]).optional(),
    store_name: z.string().min(1).max(200),
    items: z.array(z.object({
      id: z.string().min(1).max(200),
      item_id: z.string().min(1).max(200),
      name: z.string().min(1).max(500),
      quantity: z.number().int().positive(),
      nested_options: z.array(z.unknown()).optional(),
      options: z.array(z.unknown()).optional(),
      item_options: z.array(z.unknown()).optional()
    }).passthrough()).min(1).max(20)
  }).passthrough()
}).passthrough();

const CartListSchema = z.object({
  success: z.literal(true),
  carts: z.array(z.unknown())
}).passthrough();

const AddItemsSchema = z.object({
  success: z.boolean(),
  cart_uuid: z.string().min(8).max(200).optional(),
  item_errors: z.array(z.unknown()).optional()
}).passthrough();

const TipGroupSchema = z.object({
  default_index: z.number().int().nonnegative(),
  percentage_to_amount_monetary_values: z.array(MoneySchema).min(1).optional(),
  monetary_values: z.array(MoneySchema).min(1).optional()
}).passthrough().refine(
  (group) => Boolean(group.percentage_to_amount_monetary_values?.length || group.monetary_values?.length),
  "tip group must include monetary suggestions"
);

const ScheduledWindowSchema = z.object({
  display_string: z.string().min(1).max(200),
  range_min: z.string().datetime({ offset: true }),
  range_max: z.string().datetime({ offset: true }),
  midpoint_timestamp: z.string().datetime({ offset: true })
}).passthrough();

const AvailableDaySchema = z.object({
  day_timestamp: z.object({
    year: z.number().int().min(2000).max(2200),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31)
  }).passthrough(),
  time_windows: z.array(ScheduledWindowSchema)
}).passthrough();

const PreviewSchema = z.object({
  success: z.literal(true),
  cart_uuid: z.string().min(8).max(200),
  quote: z.object({
    store_order_cart: z.object({
      is_consumer_pickup: z.boolean(),
      invalid_items: z.array(z.unknown()).optional().default([]),
      fulfillment_type: z.string().optional()
    }).passthrough(),
    delivery_address: z.object({
      printable_address: z.string().min(1).max(500),
      subpremise: z.string().max(200).optional(),
      address_id: z.union([z.string(), z.number()]).optional(),
      id: z.union([z.string(), z.number()]).optional()
    }).passthrough(),
    delivery_availability: z.object({
      asap_available: z.boolean(),
      asap_pickup_available: z.boolean(),
      is_within_delivery_region: z.boolean().optional(),
      asap_minutes_range_string: z.string().optional(),
      asap_pickup_minutes_range_string: z.string().optional(),
      scheduled_delivery_available: z.boolean().optional(),
      available_days: z.array(AvailableDaySchema).optional()
    }).passthrough(),
    net_total_before_tip: MoneySchema,
    tips_suggestion_details: z.array(TipGroupSchema),
    line_items: z.array(z.object({
      label: z.string().min(1).max(100),
      charge_id: z.string().max(100).optional(),
      final_money: MoneySchema
    }).passthrough()).min(1),
    discount_banner_details: z.array(z.object({
      promotion_id: z.string().min(1).max(200).optional(),
      discount_details_message: z.string().min(1).max(500).optional()
    }).passthrough()).optional(),
    promotions: z.array(z.object({
      campaign_id: z.string().min(1).max(200).optional(),
      title: z.string().min(1).max(200).optional(),
      description: z.string().min(1).max(500).optional()
    }).passthrough()).optional(),
    dropoff_options: z.array(z.object({
      proof_of_delivery_type: z.string().min(1).max(100).optional()
    }).passthrough()).optional(),
    expense_order_options: z.object({
      all_eligible_expense_order_budgets: z.array(z.object({
        name: z.string().min(1).max(200),
        remaining_amount: MoneySchema
      }).passthrough()).optional()
    }).passthrough().optional(),
    contains_alcohol_item: z.boolean().optional(),
    min_age_requirement: z.number().int().nonnegative().optional()
  }).passthrough()
}).passthrough();

const PaymentSchema = z.object({
  success: z.literal(true),
  default_payment_method_id: z.string().min(1),
  cards: z.array(z.object({
    payment_method_id: z.string().min(1),
    last4: z.string().regex(/^\d{4}$/),
    brand: z.string().min(1).max(40)
  }).passthrough()).min(1)
}).passthrough();

const SubmitSchema = z.object({
  success: z.boolean().optional(),
  order_uuid: z.string().min(8).max(200).optional(),
  status: z.string().optional(),
  message: z.string().optional(),
  error_reason: z.string().optional(),
  result: z.object({
    order_uuid: z.string().min(8).max(200).optional(),
    status: z.string().optional(),
    status_message: z.string().optional()
  }).passthrough().optional()
}).passthrough();

const StatusSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  result: z.object({
    status: z.string().min(1),
    status_message: z.string().min(1),
    merchant_name: z.string().optional(),
    quoted_delivery_time: z.string().optional()
  }).passthrough().optional()
}).passthrough();

export interface DoorDashCommands {
  listCarts(storeId: string, intent: string): Promise<unknown>;
  addItems(storeId: string, menuId: string, items: readonly DoorDashCartItemInput[], intent: string): Promise<unknown>;
  showCart(cartUuid: string, intent: string): Promise<unknown>;
  preview(cartUuid: string, intent: string, scheduledTime?: string): Promise<unknown>;
  paymentMethods(intent: string): Promise<unknown>;
  submit(cartUuid: string, tipCents: number, intent: string, scheduledTime?: string): Promise<unknown>;
  status(orderUuid: string, intent: string): Promise<unknown>;
}

export interface CartPreparationGuard {
  beginCartPreparation(attemptId: string): { status: "acquired" | "checking" | "mutating" | "uncertain" };
  markCartPreparationMutating(attemptId: string): boolean;
  releaseCartPreparation(attemptId: string, expectedStatus: "checking" | "mutating"): boolean;
  holdCartPreparation(attemptId: string): boolean;
}

export class DoorDashCartBackend implements OrderBackend {
  readonly mode = "live" as const;
  private readonly configuredCartUuid: string | undefined;
  private readonly scheduledTime: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly cli: DoorDashCommands = new DoorDashCli(config),
    private readonly cartPreparationGuard?: CartPreparationGuard,
    private readonly now: () => Date = () => new Date()
  ) {
    this.configuredCartUuid = config.DOORDASH_DEMO_CART_UUID;
    this.scheduledTime = config.DOORDASH_SCHEDULED_TIME;
  }

  async prepareReorder(input: { request: string; intent: string }): Promise<OrderPreview> {
    const requestedTipCents = parseTipRequest(input.request);
    if (this.configuredCartUuid) return this.buildPreview(this.configuredCartUuid, input.intent, requestedTipCents, this.scheduledTime);
    if (!matchesDemoOrder(input.request)) {
      throw Object.assign(new Error("The request does not match the supervised demo order"), { code: "ORDERLY_DEMO_REQUEST_UNSUPPORTED" });
    }
    return this.createDemoCartPreview(input.intent, requestedTipCents);
  }

  async refreshPreview(previous: OrderPreview): Promise<OrderPreview> {
    if (this.configuredCartUuid && previous.cartRef !== this.configuredCartUuid) {
      throw Object.assign(new Error("The stored preview does not match the configured cart"), { code: "DOORDASH_CART_MISMATCH" });
    }
    return this.buildPreview(
      previous.cartRef,
      "Summary: Help the account owner verify the exact Orderly cart before purchase\nuser prompt/purpose: \"Recheck the approved cart before submitting it\"",
      previous.tipCents,
      this.scheduledTime
    );
  }

  async submit(input: { preview: OrderPreview; idempotencyKey: string }): Promise<OrderSubmission> {
    if (this.configuredCartUuid && input.preview.cartRef !== this.configuredCartUuid) {
      throw Object.assign(new Error("The approved cart does not match the configured cart"), { code: "DOORDASH_CART_MISMATCH" });
    }
    if ((input.preview.scheduledTime ?? undefined) !== this.scheduledTime) {
      throw Object.assign(new Error("The approved schedule does not match the configured schedule"), { code: "DOORDASH_SCHEDULE_MISMATCH" });
    }
    assertFutureSchedule(input.preview.scheduledTime, this.now());
    const raw = await this.cli.submit(
      input.preview.cartRef,
      input.preview.tipCents,
      "Summary: Help the account owner place the exact Orderly cart they approved\nuser prompt/purpose: \"Submit the transaction-bound approved order once\"",
      input.preview.scheduledTime
    );
    const parsed = SubmitSchema.parse(unwrap(raw));
    const orderRef = parsed.order_uuid ?? parsed.result?.order_uuid;
    const providerStatus = parsed.status ?? parsed.result?.status ?? "pending";
    if (parsed.success === false || /declin|fail|cancel/i.test(providerStatus)) {
      return { status: "declined", safeSummary: "DoorDash did not place the order. Review it in DoorDash before trying anything else." };
    }
    if (/action|required|verify/i.test(providerStatus)) {
      return {
        status: "action_required",
        ...(orderRef ? { orderRef } : {}),
        safeSummary: "DoorDash needs a verification step in the app or website. The order was not submitted again."
      };
    }
    if (!orderRef) {
      throw Object.assign(new Error("DoorDash accepted submit without a usable order reference"), { code: "DOORDASH_SUBMIT_OUTCOME_UNKNOWN" });
    }
    const accepted = /placed|confirm|success|scheduled/i.test(providerStatus);
    const scheduled = /scheduled/i.test(providerStatus);
    return {
      status: accepted ? "placed" : "pending",
      orderRef,
      safeSummary: accepted
        ? `DoorDash ${scheduled ? "scheduled" : "placed"} the order. Order reference ${safeRef(orderRef)}.`
        : `DoorDash is processing the order. Order reference ${safeRef(orderRef)}.`
    };
  }

  private async createDemoCartPreview(intent: string, requestedTipCents: number | undefined): Promise<OrderPreview> {
    if (!this.cartPreparationGuard) {
      throw Object.assign(new Error("Dynamic cart creation requires a durable preparation guard"), { code: "DOORDASH_CART_PREPARATION_GUARD_REQUIRED" });
    }
    const attemptId = crypto.randomUUID();
    const acquired = this.cartPreparationGuard.beginCartPreparation(attemptId);
    if (acquired.status !== "acquired") {
      const code = acquired.status === "uncertain"
        ? "DOORDASH_CART_PREPARATION_UNCERTAIN"
        : "DOORDASH_CART_PREPARATION_IN_PROGRESS";
      throw Object.assign(new Error("Another cart preparation requires review"), { code });
    }

    let existing: z.infer<typeof CartListSchema>;
    try {
      existing = CartListSchema.parse(unwrap(await this.cli.listCarts(DEMO_STORE_ID, intent)));
    } catch (error) {
      if (!this.cartPreparationGuard.releaseCartPreparation(attemptId, "checking")) {
        throw Object.assign(new Error("The cart preparation check could not be released safely"), { code: "DOORDASH_CART_PREPARATION_STATE_UNKNOWN", cause: error });
      }
      throw Object.assign(new Error("DoorDash cart preflight failed before any mutation"), { code: "DOORDASH_CART_PREFLIGHT_FAILED", cause: error });
    }
    if (existing.carts.length > 0) {
      if (!this.cartPreparationGuard.releaseCartPreparation(attemptId, "checking")) {
        throw Object.assign(new Error("The existing-cart check could not be released safely"), { code: "DOORDASH_CART_PREPARATION_STATE_UNKNOWN" });
      }
      throw Object.assign(new Error("An existing My Happy Donut cart requires review"), { code: "DOORDASH_EXISTING_CART_REQUIRES_REVIEW" });
    }

    if (!this.cartPreparationGuard.markCartPreparationMutating(attemptId)) {
      throw Object.assign(new Error("The cart preparation lock changed before mutation"), { code: "DOORDASH_CART_PREPARATION_STATE_UNKNOWN" });
    }
    try {
      const added = AddItemsSchema.parse(unwrap(await this.cli.addItems(DEMO_STORE_ID, DEMO_MENU_ID, DEMO_ITEMS, intent)));
      if (!added.success || !added.cart_uuid || (added.item_errors?.length ?? 0) > 0) {
        throw Object.assign(new Error("DoorDash did not create the exact supervised cart"), { code: "DOORDASH_CART_CREATION_UNCERTAIN" });
      }
      const preview = await this.buildPreview(added.cart_uuid, intent, requestedTipCents, this.scheduledTime);
      if (!this.cartPreparationGuard.releaseCartPreparation(attemptId, "mutating")) {
        throw Object.assign(new Error("The verified cart lock could not be released safely"), { code: "DOORDASH_CART_PREPARATION_STATE_UNKNOWN" });
      }
      return preview;
    } catch (error) {
      if (!this.cartPreparationGuard.holdCartPreparation(attemptId)) {
        throw Object.assign(new Error("The uncertain cart preparation could not be held safely"), { code: "DOORDASH_CART_PREPARATION_STATE_UNKNOWN", cause: error });
      }
      throw error;
    }
  }

  async status(orderRef: string): Promise<OrderSubmission> {
    const raw = await this.cli.status(
      orderRef,
      "Summary: Help the account owner verify the status of the Orderly purchase\nuser prompt/purpose: \"Check whether the submitted order was placed\""
    );
    const parsed = StatusSchema.parse(unwrap(raw));
    if (!parsed.success || !parsed.result) {
      return {
        status: "pending",
        orderRef,
        safeSummary: "DoorDash has not returned a conclusive status yet. I will not submit again; check the existing order before taking any action."
      };
    }
    const status = parsed.result.status.toLowerCase();
    const base = sanitizeSummary(parsed.result.status_message);
    if (/action_required|verification/.test(status)) return { status: "action_required", orderRef, safeSummary: base };
    if (/declined|cancelled|failed|not_found/.test(status)) return { status: "declined", orderRef, safeSummary: base };
    if (/placed|scheduled|store_confirmed|ready_for_pickup|dasher_assigned|dasher_at_store|picked_up|dasher_nearby|completed/.test(status)) {
      return { status: "placed", orderRef, safeSummary: base };
    }
    return { status: "pending", orderRef, safeSummary: base };
  }

  private async buildPreview(
    cartUuid: string,
    intent: string,
    requestedTipCents: number | undefined,
    scheduledTime: string | undefined
  ): Promise<OrderPreview> {
    assertFutureSchedule(scheduledTime, this.now());
    const [cartRaw, previewRaw, paymentRaw] = await Promise.all([
      this.cli.showCart(cartUuid, intent),
      this.cli.preview(cartUuid, intent, scheduledTime),
      this.cli.paymentMethods(intent)
    ]);
    const cart = CartSchema.parse(unwrap(cartRaw));
    const preview = PreviewSchema.parse(unwrap(previewRaw));
    const payment = PaymentSchema.parse(unwrap(paymentRaw));
    if (cart.cart_uuid !== cartUuid || preview.cart_uuid !== cartUuid || cart.cart.id !== cartUuid) {
      throw Object.assign(new Error("DoorDash returned a different cart"), { code: "DOORDASH_CART_MISMATCH" });
    }
    assertExactDemoCart(cart.cart);
    if (preview.quote.store_order_cart.invalid_items.length > 0) {
      throw Object.assign(new Error("The cart contains unavailable or invalid items"), { code: "DOORDASH_CART_HAS_INVALID_ITEMS" });
    }
    if (preview.quote.contains_alcohol_item || (preview.quote.min_age_requirement ?? 0) > 0) {
      throw Object.assign(new Error("Restricted items cannot be ordered through the demo"), { code: "DOORDASH_RESTRICTED_ITEM" });
    }
    if (!isConfirmedDemoAddress(preview.quote.delivery_address)) {
      throw Object.assign(new Error("The live cart is not addressed to the confirmed demo venue"), { code: "DOORDASH_DELIVERY_ADDRESS_MISMATCH" });
    }
    const isPickup = preview.quote.store_order_cart.is_consumer_pickup;
    const fulfillmentType = preview.quote.store_order_cart.fulfillment_type?.toUpperCase();
    if (isPickup || (fulfillmentType && fulfillmentType !== "DELIVERY")) {
      throw Object.assign(new Error("The supervised demo cart must use delivery"), { code: "DOORDASH_FULFILLMENT_MISMATCH" });
    }
    if (preview.quote.delivery_availability.is_within_delivery_region === false) {
      throw Object.assign(new Error("The configured cart is outside the delivery region"), { code: "DOORDASH_DELIVERY_UNAVAILABLE" });
    }
    const scheduledWindow = scheduledTime
      ? selectScheduledWindow(preview.quote.delivery_availability, scheduledTime)
      : undefined;
    if (!scheduledTime && !preview.quote.delivery_availability.asap_available) {
      throw Object.assign(new Error("The configured cart is not available for ASAP delivery"), { code: "DOORDASH_ASAP_UNAVAILABLE" });
    }
    const defaultCard = payment.cards.find((card) => card.payment_method_id === payment.default_payment_method_id);
    if (!defaultCard) {
      throw Object.assign(new Error("The default DoorDash payment method could not be named"), { code: "DOORDASH_PAYMENT_UNRESOLVED" });
    }
    const suggestedTip = suggestion(preview.quote.tips_suggestion_details);
    const tipCents = isPickup ? 0 : requestedTipCents ?? suggestedTip;
    if (!isPickup && tipCents === undefined) {
      throw Object.assign(new Error("A delivery tip must be stated or available as a DoorDash suggestion"), { code: "DOORDASH_TIP_REQUIRED" });
    }
    const finalTipCents = tipCents ?? 0;
    const totalBeforeTip = preview.quote.net_total_before_tip.unit_amount;
    const totalCents = totalBeforeTip + finalTipCents;
    const itemSummary = cart.cart.items
      .map((item) => `${item.quantity} × ${normalize(item.name)}`)
      .join(", ")
      .slice(0, 500);
    const eta = scheduledTime ? undefined : isPickup
      ? preview.quote.delivery_availability.asap_pickup_minutes_range_string
      : preview.quote.delivery_availability.asap_minutes_range_string;
    const requiresPinHandoff = (preview.quote.dropoff_options ?? [])
      .some((option) => option.proof_of_delivery_type?.toUpperCase() === "PIN_CODE");
    const priceBreakdown = (preview.quote.line_items ?? [])
      .map((line) => `${normalize(line.label)} ${normalize(line.final_money.display_string)}`)
      .join(", ")
      .slice(0, 500);
    const promotionSummary = appliedPromotionSummary(preview.quote);
    const workBenefitSummary = eligibleWorkBenefitSummary(preview.quote);
    const authorizationSnapshot = {
      cartUuid,
      storeName: normalize(cart.cart.store_name),
      items: cart.cart.items
        .map((item) => ({
          itemId: item.item_id.replace(/^i_/, ""),
          name: normalize(item.name),
          quantity: item.quantity
        }))
        .sort((a, b) => a.itemId.localeCompare(b.itemId)),
      fulfillmentType: fulfillmentType ?? "DELIVERY",
      addressId: String(preview.quote.delivery_address.address_id ?? preview.quote.delivery_address.id ?? ""),
      address: normalize(preview.quote.delivery_address.printable_address),
      netTotalBeforeTip: preview.quote.net_total_before_tip,
      priceBreakdown,
      promotionSummary: promotionSummary ?? null,
      workBenefitSummary: workBenefitSummary ?? null,
      defaultPaymentMethodId: payment.default_payment_method_id,
      defaultCard: { brand: normalize(defaultCard.brand), last4: defaultCard.last4 },
      tipCents: finalTipCents,
      scheduledTime: scheduledWindow?.midpointTimestamp ?? null,
      scheduledWindow: scheduledWindow ?? null,
      requiresPinHandoff,
      restricted: Boolean(preview.quote.contains_alcohol_item || (preview.quote.min_age_requirement ?? 0) > 0)
    };
    return {
      providerMode: "live",
      providerSnapshotHash: `sha256:${crypto.createHash("sha256").update(stableJson(authorizationSnapshot)).digest("hex")}`,
      cartRef: cartUuid,
      storeName: normalize(cart.cart.store_name).slice(0, 100),
      itemSummary,
      subtotalCents: totalBeforeTip,
      feesCents: 0,
      taxCents: 0,
      tipCents: finalTipCents,
      creditsCents: 0,
      totalCents,
      addressSummary: normalize(preview.quote.delivery_address.printable_address).slice(0, 100),
      paymentSummary: `${normalize(defaultCard.brand)} ending ${defaultCard.last4}`.slice(0, 100),
      ...(scheduledWindow ? { scheduledTime: scheduledWindow.midpointTimestamp } : {}),
      ...(eta ? { etaSummary: normalize(eta).slice(0, 100) } : {}),
      ...(priceBreakdown ? { priceBreakdown } : {}),
      ...(promotionSummary ? { promotionSummary } : {}),
      ...(workBenefitSummary ? { workBenefitSummary } : {}),
      ...(requiresPinHandoff ? { requiresPinHandoff: true } : {})
    };
  }
}

type DeliveryAvailability = z.infer<typeof PreviewSchema>["quote"]["delivery_availability"];

function selectScheduledWindow(availability: DeliveryAvailability, scheduledTime: string): {
  dayTimestamp: { year: number; month: number; day: number };
  displayString: string;
  rangeMin: string;
  rangeMax: string;
  midpointTimestamp: string;
} {
  const requestedInstant = new Date(scheduledTime).getTime();
  const matches = (availability.available_days ?? []).flatMap((availableDay) =>
    availableDay.time_windows
      .filter((window) => new Date(window.midpoint_timestamp).getTime() === requestedInstant)
      .map((window) => ({ availableDay, window }))
  );
  if (availability.scheduled_delivery_available === false || matches.length === 0) {
    throw Object.assign(new Error("DoorDash did not offer the configured scheduled-delivery midpoint"), {
      code: "DOORDASH_SCHEDULE_NOT_AVAILABLE"
    });
  }
  if (matches.length !== 1) {
    throw Object.assign(new Error("DoorDash returned an ambiguous scheduled-delivery midpoint"), {
      code: "DOORDASH_SCHEDULE_AMBIGUOUS"
    });
  }
  const { availableDay, window } = matches[0]!;
  const rangeMin = new Date(window.range_min).getTime();
  const rangeMax = new Date(window.range_max).getTime();
  if (rangeMin > requestedInstant || requestedInstant > rangeMax) {
    throw Object.assign(new Error("DoorDash returned an invalid scheduled-delivery window"), {
      code: "DOORDASH_SCHEDULE_WINDOW_INVALID"
    });
  }
  return {
    dayTimestamp: { ...availableDay.day_timestamp },
    displayString: normalize(window.display_string),
    rangeMin: new Date(rangeMin).toISOString(),
    rangeMax: new Date(rangeMax).toISOString(),
    midpointTimestamp: new Date(requestedInstant).toISOString()
  };
}

function assertExactDemoCart(cart: z.infer<typeof CartSchema>["cart"]): void {
  if (normalize(cart.store_name).toLowerCase() !== DEMO_STORE_NAME.toLowerCase()) {
    throw Object.assign(new Error("The cart is from an unexpected store"), { code: "DOORDASH_CART_CONTENT_MISMATCH" });
  }
  if (cart.store_id !== undefined && String(cart.store_id) !== DEMO_STORE_ID) {
    throw Object.assign(new Error("The cart has an unexpected store ID"), { code: "DOORDASH_CART_CONTENT_MISMATCH" });
  }
  const expectedById = new Map(DEMO_ITEMS.map((item) => [item.itemId, item]));
  const actual = new Map<string, number>();
  for (const item of cart.items) {
    const id = item.item_id.replace(/^i_/, "");
    const expected = expectedById.get(id);
    const hasOptions = (item.nested_options?.length ?? 0) > 0
      || (item.options?.length ?? 0) > 0
      || (item.item_options?.length ?? 0) > 0;
    if (!expected || normalize(item.name).toLowerCase() !== expected.itemName.toLowerCase() || hasOptions || actual.has(id)) {
      throw Object.assign(new Error("The cart has duplicate item lines"), { code: "DOORDASH_CART_CONTENT_MISMATCH" });
    }
    actual.set(id, item.quantity);
  }
  if (actual.size !== DEMO_ITEMS.length || DEMO_ITEMS.some((item) => actual.get(item.itemId) !== item.quantity)) {
    throw Object.assign(new Error("The cart does not match the approved demo basket"), { code: "DOORDASH_CART_CONTENT_MISMATCH" });
  }
}

function matchesDemoOrder(request: string): boolean {
  const normalized = normalize(request)
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/[,:!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/\b(?:do\s+not|don't|dont|cancel|never\s*mind|mixed|two\s+dozen|2\s+dozen)\b/.test(normalized)) return false;
  const opener = "(?:please\\s+)?(?:order(?:\\s+me)?|get\\s+me|i\\s+want|i\\s+would\\s+like|i'd\\s+like|can\\s+you\\s+(?:order(?:\\s+me)?|get\\s+me))";
  const basket = "(?:12|twelve|a\\s+dozen|one\\s+dozen)\\s+(?:regular\\s+)?donut\\s+holes?\\s+(?:and|plus)\\s+(?:2|two|a\\s+couple(?:\\s+of)?)\\s+apple\\s+fritters?";
  const store = "(?:from|at)\\s+my\\s+happy\\s+donut";
  const tip = "(?:\\s+(?:with|and)\\s+(?:(?:a\\s+)?(?:\\$?\\d{1,3}(?:\\.\\d{1,2})?|no|zero)\\s+tip|a\\s+tip\\s+of\\s+\\$?\\d{1,3}(?:\\.\\d{1,2})?))?";
  return new RegExp(`^${opener}\\s+${basket}\\s+${store}${tip}$`, "i").test(normalized)
    || new RegExp(`^${opener}\\s+${store}\\s+${basket}${tip}$`, "i").test(normalized);
}

function isConfirmedDemoAddress(address: z.infer<typeof PreviewSchema>["quote"]["delivery_address"]): boolean {
  const providerId = address.address_id ?? address.id;
  if (providerId !== undefined && String(providerId) !== DEMO_ADDRESS_ID) return false;
  const printable = normalize(address.printable_address);
  const addressWithUnit = `${printable} ${normalize(address.subpremise ?? "")}`.trim();
  if (!hasNoFloorOrOnlySecondFloor(addressWithUnit)) return false;
  if (/\b(?:suite|ste|unit)\b/i.test(addressWithUnit)
    && !/\bunit\s+(?:2nd|second)\s+floor\b/i.test(addressWithUnit)) return false;
  return /\b525\s+Market\s+(?:Street|St\.?)\b/i.test(printable)
    && /\bSan\s+Francisco\b/i.test(printable)
    && /\bCA\b/i.test(printable)
    && /\b94105\b/.test(printable);
}

function hasNoFloorOrOnlySecondFloor(value: string): boolean {
  const aliases: Record<string, number> = {
    one: 1, first: 1,
    two: 2, second: 2,
    three: 3, third: 3,
    four: 4, fourth: 4,
    five: 5, fifth: 5
  };
  const floors: number[] = [];
  for (const match of value.matchAll(/\b(\d+|one|two|three|four|five|first|second|third|fourth|fifth)(?:st|nd|rd|th)?\s*(?:floor|fl)\b/gi)) {
    const raw = match[1]!.toLowerCase();
    floors.push(/^\d+$/.test(raw) ? Number(raw) : aliases[raw]!);
  }
  for (const match of value.matchAll(/\b(?:floor|fl)\s*(\d+|one|two|three|four|five|first|second|third|fourth|fifth)\b/gi)) {
    const raw = match[1]!.toLowerCase();
    floors.push(/^\d+$/.test(raw) ? Number(raw) : aliases[raw]!);
  }
  return floors.length === 0 || floors.every((floor) => floor === 2);
}

function appliedPromotionSummary(quote: z.infer<typeof PreviewSchema>["quote"]): string | undefined {
  const ids = new Set((quote.discount_banner_details ?? []).map((detail) => detail.promotion_id).filter(Boolean));
  const titles = (quote.promotions ?? [])
    .filter((promotion) => promotion.campaign_id && ids.has(promotion.campaign_id))
    .map((promotion) => promotion.title)
    .filter((title): title is string => Boolean(title));
  const savings = (quote.discount_banner_details ?? [])
    .map((detail) => detail.discount_details_message)
    .filter((message): message is string => Boolean(message));
  const parts = [...new Set([...titles, ...savings].map(normalize))];
  return parts.length > 0 ? parts.join("; ").slice(0, 300) : undefined;
}

function eligibleWorkBenefitSummary(quote: z.infer<typeof PreviewSchema>["quote"]): string | undefined {
  const budgets = (quote.expense_order_options?.all_eligible_expense_order_budgets ?? [])
    .filter((budget) => budget.remaining_amount.unit_amount > 0)
    .slice(0, 3)
    .map((budget) => `${normalize(budget.name)} ${normalize(budget.remaining_amount.display_string)}`);
  return budgets.length > 0 ? budgets.join(", ").slice(0, 300) : undefined;
}

function unwrap(value: unknown): unknown {
  const envelope = EnvelopeSchema.parse(value);
  if (envelope.isError) throw Object.assign(new Error("DoorDash returned an error envelope"), { code: "DOORDASH_ERROR_ENVELOPE" });
  return envelope.structuredContent;
}

function suggestion(groups: z.infer<typeof TipGroupSchema>[]): number | undefined {
  const group = groups[0];
  if (!group) return undefined;
  const values = group.percentage_to_amount_monetary_values ?? group.monetary_values ?? [];
  return values[group.default_index]?.unit_amount;
}

function parseTipRequest(request: string): number | undefined {
  const normalized = request.toLowerCase();
  if (/\b(?:no|zero)\s+tip\b/.test(normalized)) return 0;
  const match = normalized.match(/\btip(?:\s+of)?\s*\$?(\d{1,3}(?:\.\d{1,2})?)\b/) ?? normalized.match(/\$(\d{1,3}(?:\.\d{1,2})?)\s+tip\b/);
  if (!match?.[1]) return undefined;
  const cents = Math.round(Number(match[1]) * 100);
  if (!Number.isInteger(cents) || cents < 0 || cents > 20_000) return undefined;
  return cents;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalize(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeSummary(value: string): string {
  return normalize(value).slice(0, 500) || "DoorDash is still processing the order.";
}

function safeRef(value: string): string {
  return normalize(value).slice(-12);
}

function assertFutureSchedule(scheduledTime: string | undefined, now: Date): void {
  if (scheduledTime && new Date(scheduledTime).getTime() <= now.getTime()) {
    throw Object.assign(new Error("The configured delivery schedule is no longer in the future"), { code: "DOORDASH_SCHEDULE_NOT_FUTURE" });
  }
}
