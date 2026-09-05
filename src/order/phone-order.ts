import crypto from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { SmsStore } from "../store/store.js";
import type { MessageHandler, VoiceTurnHandler, VoiceTurnResult } from "../types.js";
import { isClearSpokenYes, normalizeSpokenInput as normalizeText } from "./confirmation.js";

export interface OrderPreview {
  providerMode: "mock" | "live";
  providerSnapshotHash?: string | undefined;
  cartRef: string;
  storeName: string;
  itemSummary: string;
  subtotalCents: number;
  feesCents: number;
  taxCents: number;
  tipCents: number;
  creditsCents: number;
  totalCents: number;
  addressSummary: string;
  paymentSummary: string;
  scheduledTime?: string | undefined;
  etaSummary?: string | undefined;
  priceBreakdown?: string | undefined;
  promotionSummary?: string | undefined;
  workBenefitSummary?: string | undefined;
  requiresPinHandoff?: boolean | undefined;
}

export interface OrderSubmission {
  status: "pending" | "placed" | "action_required" | "declined";
  orderRef?: string | undefined;
  safeSummary: string;
}

export interface OrderBackend {
  readonly mode: "mock" | "live";
  prepareReorder(input: { request: string; intent: string }): Promise<OrderPreview>;
  refreshPreview?(preview: OrderPreview): Promise<OrderPreview>;
  submit(input: { preview: OrderPreview; idempotencyKey: string }): Promise<OrderSubmission>;
  status?(orderRef: string): Promise<OrderSubmission>;
}

const StoredPreviewSchema = z.object({
  providerMode: z.enum(["mock", "live"]),
  providerSnapshotHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  cartRef: z.string().min(1).max(200),
  storeName: z.string().min(1).max(100),
  itemSummary: z.string().min(1).max(500),
  subtotalCents: z.number().int().nonnegative(),
  feesCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  tipCents: z.number().int().nonnegative(),
  creditsCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  addressSummary: z.string().min(1).max(100),
  paymentSummary: z.string().min(1).max(100),
  scheduledTime: z.string().datetime({ offset: true }).optional(),
  etaSummary: z.string().min(1).max(100).optional(),
  priceBreakdown: z.string().min(1).max(500).optional(),
  promotionSummary: z.string().min(1).max(300).optional(),
  workBenefitSummary: z.string().min(1).max(300).optional(),
  requiresPinHandoff: z.boolean().optional()
}).strict();

const OrderSubmissionSchema = z.object({
  status: z.enum(["pending", "placed", "action_required", "declined"]),
  orderRef: z.string().min(1).max(200).optional(),
  safeSummary: z.string().min(1).max(500)
}).strict().superRefine((value, ctx) => {
  if (["pending", "placed"].includes(value.status) && !value.orderRef) {
    ctx.addIssue({ code: "custom", path: ["orderRef"], message: "Pending and placed results require an order reference" });
  }
});

const PhoneOrderStateSchema = z.object({
  schemaVersion: z.literal(1),
  stage: z.enum([
    "ready",
    "preparing",
    "awaiting_confirmation",
    "submitting",
    "placed",
    "reconciliation_required",
    "demo_confirmed",
    "abandoned"
  ]),
  preview: StoredPreviewSchema.optional(),
  previewHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  confirmationCode: z.string().regex(/^\d{4}$/).optional(),
  confirmationPhrase: z.string().min(1).max(120).optional(),
  confirmationExpiresAt: z.string().datetime({ offset: true }).optional(),
  purchaseRunId: z.string().uuid().optional(),
  activeCallId: z.string().min(1).max(200).optional(),
  approvalId: z.string().uuid().optional(),
  orderRef: z.string().min(1).max(200).optional(),
  lastSafeSummary: z.string().max(500).optional()
}).strict();

type PhoneOrderState = z.infer<typeof PhoneOrderStateSchema>;

export class MockOrderBackend implements OrderBackend {
  readonly mode = "mock" as const;
  submitCalls = 0;

  async prepareReorder(_input: { request: string; intent: string }): Promise<OrderPreview> {
    return {
      providerMode: "mock",
      cartRef: "cart_mock_harbor_bowl",
      storeName: "Harbor Bowl Kitchen",
      itemSummary: "one chicken and rice bowl, no onions",
      subtotalCents: 1850,
      feesCents: 299,
      taxCents: 173,
      tipCents: 350,
      creditsCents: 0,
      totalCents: 2672,
      addressSummary: "Home, ZIP ending 4104",
      paymentSummary: "demo Visa ending 4242"
    };
  }

  async submit(_input: { preview: OrderPreview; idempotencyKey: string }): Promise<OrderSubmission> {
    this.submitCalls += 1;
    throw Object.assign(new Error("Mock backend cannot submit an order"), { code: "PURCHASE_DISABLED" });
  }
}

export class PhoneOrderCoordinator {
  constructor(
    private readonly store: SmsStore,
    private readonly backend: OrderBackend,
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly confirmationCode: () => string = () => String(crypto.randomInt(1000, 10_000))
  ) {}

  async handleTurn(input: {
    deliveryId: string;
    sender: string;
    text: string;
    channel: "sms" | "voice";
    callId?: string;
  }): Promise<VoiceTurnResult> {
    const text = normalizeText(input.text);
    if (!text) return { text: "I didn't hear a request. Please say whether you want a previous meal, something new, or help from a person." };

    const loaded = this.loadState(input.sender);
    let state = loaded.state;
    let version = loaded.version;
    const callId = input.channel === "voice" ? reliableCallId(input.callId) : undefined;
    const purchaseRunId = this.config.DOORDASH_PURCHASE_RUN_ID;

    if (purchaseRunId && state.purchaseRunId !== purchaseRunId && canChangePurchaseRun(state.stage)) {
      state = emptyState(callId, purchaseRunId);
      version = this.saveState(input.sender, version, state);
    }

    if (callId && state.activeCallId !== callId && canStartFreshCall(state.stage)) {
      state = emptyState(callId, purchaseRunId);
      version = this.saveState(input.sender, version, state);
    }

    if (state.stage === "submitting" || state.stage === "reconciliation_required") {
      return this.reconcileWithoutResubmit(input.sender, version, state);
    }

    if (state.stage === "placed") {
      return {
        text: state.lastSafeSummary ?? "Your order was placed. I can text the receipt and status when messaging is enabled.",
        hangup: input.channel === "voice"
      };
    }

    if (isCancel(text)) {
      state = {
        schemaVersion: 1,
        stage: "abandoned",
        ...(purchaseRunId ? { purchaseRunId } : {}),
        ...(callId ? { activeCallId: callId } : {}),
        lastSafeSummary: "The order was cancelled before submission."
      };
      this.saveState(input.sender, version, state);
      return { text: "Okay. I cancelled this Orderly session before submission. Nothing was purchased.", hangup: input.channel === "voice" };
    }

    if (isReset(text)) {
      state = emptyState(callId, purchaseRunId);
      this.saveState(input.sender, version, state);
      return { text: "Okay, starting over. What would you like to order?" };
    }

    if (state.stage === "awaiting_confirmation") {
      if (!state.confirmationExpiresAt || this.now().getTime() < new Date(state.confirmationExpiresAt).getTime()) {
        return this.handleConfirmation(input, version, state, text);
      }
      const expiredConfirmationPhrase = state.confirmationPhrase;
      state = emptyState(callId, purchaseRunId);
      version = this.saveState(input.sender, version, state);
      if (isClearSpokenYes(text)
        || (expiredConfirmationPhrase
          && normalizeConfirmation(text) === normalizeConfirmation(expiredConfirmationPhrase))) {
        return { text: "That checkout expired, so yes cannot place anything. Tell me what you want and I will get a fresh total." };
      }
    }

    if (state.stage === "preparing") {
      return { text: "I am checking DoorDash now. Please hold on for the total." };
    }

    if (isNegativeResponse(text)) {
      return { text: "Okay. Nothing was purchased. Tell me what you want whenever you are ready." };
    }

    const shouldPrepare = input.channel === "voice"
      ? !isClearSpokenYes(text)
      : looksLikeOrderRequest(text);
    if (shouldPrepare) {
      if (this.backend.mode === "live" && this.store.hasOpenOrderSubmission()) {
        return { text: "A previous DoorDash submission still needs reconciliation. I will not prepare another checkout." };
      }
      if (this.backend.mode === "live" && (
        purchaseRunId ? this.store.purchaseRunConsumed(purchaseRunId) : this.store.orderSubmissionCount() > 0
      )) {
        return { text: "This authorized Orderly purchase run is already consumed. I will not prepare or submit it again." };
      }
      const preparing: PhoneOrderState = {
        schemaVersion: 1,
        stage: "preparing",
        ...(purchaseRunId ? { purchaseRunId } : {}),
        ...(callId ? { activeCallId: callId } : {})
      };
      version = this.saveState(input.sender, version, preparing);
      let preview: OrderPreview;
      try {
        preview = await this.backend.prepareReorder({
          request: input.text,
          intent: fixedDoorDashIntent(input.text)
        });
      } catch (error) {
        const code = errorCode(error);
        if (code === "ORDERLY_DEMO_REQUEST_UNSUPPORTED") {
          this.saveState(input.sender, version, emptyState(undefined, purchaseRunId));
          return { text: "For this supervised demo, please say: Order 12 regular donut holes and two apple fritters from My Happy Donut." };
        }
        if (code === "DOORDASH_EXISTING_CART_REQUIRES_REVIEW") {
          this.saveState(input.sender, version, emptyState(undefined, purchaseRunId));
          return { text: "I found an existing My Happy Donut cart, so I did not change it. The demo operator needs to review that cart before we continue." };
        }
        if (code === "DOORDASH_CART_PREFLIGHT_FAILED") {
          this.saveState(input.sender, version, emptyState(undefined, purchaseRunId));
          return { text: "I couldn't check DoorDash before creating a cart, so I changed nothing. Please try the request again." };
        }
        if (code === "DOORDASH_CART_PREPARATION_IN_PROGRESS") {
          this.saveState(input.sender, version, emptyState(undefined, purchaseRunId));
          return { text: "Orderly is already checking this demo cart. I did not add anything. Please wait a moment, then try again." };
        }
        const held: PhoneOrderState = {
          schemaVersion: 1,
          stage: "reconciliation_required",
          ...(purchaseRunId ? { purchaseRunId } : {}),
          lastSafeSummary: isAmbiguousError(error)
            ? "The cart preparation result is uncertain. I will not try again until the demo operator checks DoorDash. No paid order was submitted."
            : "I couldn't safely verify the exact cart. I will not try again until the demo operator checks DoorDash. No paid order was submitted."
        };
        this.saveState(input.sender, version, held);
        return { text: held.lastSafeSummary ?? "I could not safely verify the exact cart. No paid order was submitted." };
      }
      validatePreview(preview, this.config.ORDER_TOTAL_LIMIT_CENTS);
      const code = this.confirmationCode();
      const expiresAt = new Date(this.now().getTime() + this.config.CHECKOUT_CONFIRM_TTL_SECONDS * 1000).toISOString();
      const phrase = preview.providerMode === "live"
        ? liveConfirmationPhrase(preview, code)
        : `Confirm demo order ${code}`;
      const previewHash = approvalHash(preview, code, expiresAt);
      state = {
        schemaVersion: 1,
        stage: "awaiting_confirmation",
        preview,
        previewHash,
        confirmationCode: code,
        confirmationPhrase: phrase,
        confirmationExpiresAt: expiresAt,
        ...(purchaseRunId ? { purchaseRunId } : {}),
        ...(callId ? { activeCallId: callId } : {})
      };
      this.saveState(input.sender, version, state);
      return { text: previewPrompt(preview, phrase, input.channel) };
    }

    return {
      text: input.channel === "voice"
        ? "I do not have an active checkout yet. Tell me what you want to order."
        : openingPrompt()
    };
  }

  private async handleConfirmation(
    input: { deliveryId: string; sender: string; text: string; channel: "sms" | "voice" },
    version: number,
    state: PhoneOrderState,
    normalizedText: string
  ): Promise<VoiceTurnResult> {
    if (!state.preview || !state.confirmationPhrase || !state.confirmationExpiresAt || !state.previewHash) {
      throw Object.assign(new Error("Stored confirmation state is incomplete"), { code: "STATE_CORRUPT" });
    }
    if (this.now().getTime() >= new Date(state.confirmationExpiresAt).getTime()) {
      this.saveState(input.sender, version, emptyState(undefined, this.config.DOORDASH_PURCHASE_RUN_ID));
      return { text: "That price confirmation expired. Nothing was purchased. Please ask me to prepare the order again." };
    }
    if (state.preview.workBenefitSummary && /\b(?:work|company)\s+(?:benefit|budget|payment)|\buse\s+(?:the\s+)?budget\b/i.test(normalizedText)) {
      return {
        text: `I will not silently charge the card while a work benefit is available. This prototype cannot apply that budget safely. Nothing was submitted. To use the named card instead, say exactly: ${state.confirmationPhrase}.`
      };
    }
    const exactConfirmation = normalizeConfirmation(normalizedText) === normalizeConfirmation(state.confirmationPhrase);
    const naturalVoiceConfirmation = input.channel === "voice"
      && !state.preview.workBenefitSummary
      && !state.preview.requiresPinHandoff
      && isClearSpokenYes(normalizedText);
    if (!exactConfirmation && !naturalVoiceConfirmation) {
      if (input.channel === "sms" && isClearSpokenYes(normalizedText)) {
        return { text: `I cannot accept a general yes by text. To approve this exact ${state.preview.providerMode === "live" ? "purchase" : "demo"}, reply: ${state.confirmationPhrase}.` };
      }
      if (input.channel === "voice" && !state.preview.workBenefitSummary && !state.preview.requiresPinHandoff) {
        return {
          text: `I have the cart ready${state.preview.scheduledTime ? ` for ${formatScheduledTime(state.preview.scheduledTime)}` : ""}. The exact total is ${formatMoney(state.preview.totalCents)}, including a ${formatMoney(state.preview.tipCents)} tip. Say yes to place it, or say cancel.`
        };
      }
      return { text: `That did not approve this exact ${state.preview.providerMode === "live" ? "purchase" : "demo"}. To use the transaction-specific phrase, say: ${state.confirmationPhrase}.` };
    }

    if (!this.config.PURCHASE_ENABLED || state.preview.providerMode !== "live" || this.backend.mode !== "live") {
      const livePreviewRehearsal = state.preview.providerMode === "live" && this.backend.mode === "live";
      const safeConfirmation = livePreviewRehearsal
        ? "Your live checkout preview was confirmed for rehearsal. No real purchase was placed."
        : "Your mock order was confirmed. No real purchase was placed.";
      const confirmed: PhoneOrderState = {
        ...state,
        stage: "demo_confirmed",
        lastSafeSummary: safeConfirmation
      };
      this.saveState(input.sender, version, confirmed);
      return {
        text: safeConfirmation,
        hangup: input.channel === "voice"
      };
    }

    if (!this.config.DOORDASH_ACCOUNT_CONNECTED_VERIFIED || !this.config.DD_CLI_ACCESS_TOKEN) {
      return { text: "DoorDash is not connected, so I cannot safely place this order. Nothing was purchased." };
    }

    if (!this.backend.refreshPreview) {
      return { text: "The live cart cannot be rechecked safely, so I will not submit it. Nothing was purchased." };
    }

    let refreshed: OrderPreview;
    try {
      refreshed = await this.backend.refreshPreview(state.preview);
      validatePreview(refreshed, this.config.ORDER_TOTAL_LIMIT_CENTS);
    } catch {
      return { text: "I could not recheck the live cart safely, so I will not submit it. Nothing was purchased." };
    }
    if (canonicalPreview(refreshed) !== canonicalPreview(state.preview)) {
      const code = this.confirmationCode();
      const expiresAt = new Date(this.now().getTime() + this.config.CHECKOUT_CONFIRM_TTL_SECONDS * 1000).toISOString();
      const phrase = liveConfirmationPhrase(refreshed, code);
      const changed: PhoneOrderState = {
        schemaVersion: 1,
        stage: "awaiting_confirmation",
        preview: refreshed,
        previewHash: approvalHash(refreshed, code, expiresAt),
        confirmationCode: code,
        confirmationPhrase: phrase,
        confirmationExpiresAt: expiresAt,
        ...(state.purchaseRunId ? { purchaseRunId: state.purchaseRunId } : {}),
        ...(state.activeCallId ? { activeCallId: state.activeCallId } : {})
      };
      this.saveState(input.sender, version, changed);
      return { text: `The cart or price changed, so the old approval is invalid. Nothing was submitted. ${previewPrompt(refreshed, phrase, input.channel)}` };
    }

    const purchaseRunId = this.config.DOORDASH_PURCHASE_RUN_ID;
    if (!purchaseRunId) {
      return { text: "This live purchase has no fresh authorized run ID, so I will not submit it. Nothing was purchased." };
    }
    const approvalId = crypto.randomUUID();
    const submitKey = `sha256:${crypto.createHash("sha256")
      .update(`${purchaseRunId}|${input.sender}|${state.previewHash}|${approvalId}`)
      .digest("hex")}`;
    const submitting: PhoneOrderState = { ...state, stage: "submitting", approvalId };
    const startedVersion = this.store.beginOrderSubmission({
      phone: input.sender,
      expectedSessionVersion: version,
      nextStateJson: JSON.stringify(submitting),
      approvalId,
      purchaseRunId,
      previewHash: state.previewHash,
      idempotencyKey: submitKey
    });
    if (startedVersion === undefined) {
      throw Object.assign(new Error("Concurrent or duplicate order submission rejected"), { code: "SUBMIT_LOCKED" });
    }
    version = startedVersion;

    let result: OrderSubmission;
    try {
      result = parseSubmission(await this.backend.submit({ preview: refreshed, idempotencyKey: submitKey }));
    } catch {
      const held: PhoneOrderState = {
        ...submitting,
        stage: "reconciliation_required",
        lastSafeSummary: "The order result is uncertain. Do not repeat it while Orderly checks DoorDash."
      };
      const committed = this.store.completeOrderSubmission({
        phone: input.sender,
        expectedSessionVersion: version,
        nextStateJson: JSON.stringify(held),
        approvalId,
        status: "ambiguous",
        safeSummary: held.lastSafeSummary ?? "The order result is uncertain."
      });
      if (committed === undefined) throw Object.assign(new Error("Could not persist ambiguous order outcome"), { code: "SUBMIT_LEDGER_CONFLICT" });
      return {
        text: "The order result is uncertain. I will not try again. Please check DoorDash before placing another order.",
        hangup: input.channel === "voice"
      };
    }

    const finalStage = result.status === "placed" ? "placed" : "reconciliation_required";
    const completed: PhoneOrderState = {
      ...submitting,
      stage: finalStage,
      ...(result.orderRef ? { orderRef: result.orderRef } : {}),
      lastSafeSummary: result.safeSummary
    };
    const committed = this.store.completeOrderSubmission({
      phone: input.sender,
      expectedSessionVersion: version,
      nextStateJson: JSON.stringify(completed),
      approvalId,
      status: result.status === "placed" ? "placed" : result.status,
      ...(result.orderRef ? { orderRef: result.orderRef } : {}),
      safeSummary: result.safeSummary
    });
    if (committed === undefined) throw Object.assign(new Error("Could not persist order outcome"), { code: "SUBMIT_LEDGER_CONFLICT" });
    return {
      text: result.safeSummary,
      ...(result.status === "placed" ? { followUpSms: result.safeSummary } : {}),
      hangup: input.channel === "voice" && result.status !== "pending"
    };
  }

  private async reconcileWithoutResubmit(sender: string, version: number, state: PhoneOrderState): Promise<VoiceTurnResult> {
    if (!state.orderRef || !this.backend.status) {
      return { text: state.lastSafeSummary ?? "This order needs manual review. I will not submit it again." };
    }
    let result: OrderSubmission;
    try {
      result = parseSubmission(await this.backend.status(state.orderRef));
    } catch {
      return { text: "I still cannot verify the order. I will not submit it again. Please check DoorDash." };
    }
    if (!state.approvalId) {
      return { text: "I cannot safely match this result to its approval. I will not submit it again. Please check DoorDash." };
    }
    const nextStage: PhoneOrderState["stage"] = result.status === "placed"
      ? "placed"
      : result.status === "declined" ? "abandoned" : "reconciliation_required";
    const reconciled: PhoneOrderState = {
      ...state,
      stage: nextStage,
      ...(result.orderRef ? { orderRef: result.orderRef } : {}),
      lastSafeSummary: result.safeSummary
    };
    const committed = this.store.reconcileOrderSubmission({
      phone: sender,
      expectedSessionVersion: version,
      nextStateJson: JSON.stringify(reconciled),
      approvalId: state.approvalId,
      status: result.status,
      ...(result.orderRef ? { orderRef: result.orderRef } : {}),
      safeSummary: result.safeSummary
    });
    if (committed === undefined) {
      return { text: "I found a DoorDash result, but could not safely commit it. I will not submit again. Please check DoorDash." };
    }
    return {
      text: result.safeSummary,
      ...(result.status === "placed" ? { followUpSms: result.safeSummary } : {})
    };
  }

  private loadState(sender: string): { version: number; state: PhoneOrderState } {
    const stored = this.store.loadConversationState(sender);
    if (!stored) return { version: 0, state: emptyState() };
    const parsed = PhoneOrderStateSchema.safeParse(JSON.parse(stored.stateJson));
    if (!parsed.success) throw Object.assign(new Error("Stored phone order state is invalid"), { code: "STATE_CORRUPT" });
    return { version: stored.version, state: parsed.data };
  }

  private saveState(sender: string, expectedVersion: number, state: PhoneOrderState): number {
    const next = this.store.saveConversationState(sender, expectedVersion, JSON.stringify(state));
    if (next === undefined) throw Object.assign(new Error("Concurrent phone order update rejected"), { code: "STATE_CONFLICT" });
    return next;
  }
}

export class PhoneOrderMessageHandler implements MessageHandler {
  readonly retrySafety = "unknown" as const;
  constructor(private readonly coordinator: PhoneOrderCoordinator) {}
  async handle(message: { deliveryId: string; idempotencyKey: string; sender: string; body: string }): Promise<string> {
    const result = await this.coordinator.handleTurn({
      deliveryId: message.deliveryId,
      sender: message.sender,
      text: message.body,
      channel: "sms"
    });
    return result.text;
  }
}

export class PhoneOrderVoiceHandler implements VoiceTurnHandler {
  constructor(private readonly coordinator: PhoneOrderCoordinator) {}
  handle(turn: { deliveryId: string; sender: string; transcript: string; callId: string }): Promise<VoiceTurnResult> {
    return this.coordinator.handleTurn({
      deliveryId: turn.deliveryId,
      sender: turn.sender,
      text: turn.transcript,
      channel: "voice",
      ...(turn.callId ? { callId: turn.callId } : {})
    });
  }
}

function emptyState(callId?: string, purchaseRunId?: string): PhoneOrderState {
  return {
    schemaVersion: 1,
    stage: "ready",
    ...(purchaseRunId ? { purchaseRunId } : {}),
    ...(callId ? { activeCallId: callId } : {})
  };
}

function openingPrompt(): string {
  return "What would you like to order? You can ask for twelve regular donut holes and two apple fritters from My Happy Donut.";
}

function previewPrompt(preview: OrderPreview, phrase: string, channel: "sms" | "voice" = "sms"): string {
  const mode = preview.providerMode === "mock" ? "This is a mock preview." : "";
  if (channel === "voice" && !preview.workBenefitSummary && !preview.requiresPinHandoff) {
    return [
      mode,
      `I found ${compactSpeech(preview.itemSummary, 150)} from ${compactSpeech(preview.storeName, 60)}.`,
      `Delivery is to ${compactSpeech(preview.addressSummary, 80)}.`,
      `Payment is ${compactSpeech(preview.paymentSummary, 60)}.`,
      preview.scheduledTime ? `Delivery is scheduled for ${formatScheduledTime(preview.scheduledTime)}.` : "",
      preview.etaSummary ? `Estimated delivery is ${compactSpeech(preview.etaSummary, 50)}.` : "",
      preview.promotionSummary ? `Savings are ${compactSpeech(preview.promotionSummary, 70)}.` : "",
      `The exact total is ${formatMoney(preview.totalCents)}, including a ${formatMoney(preview.tipCents)} tip. Say yes now to confirm.`
    ].filter(Boolean).join(" ");
  }
  const essential = [
    mode,
    `I found ${compactSpeech(preview.itemSummary, 180)} from ${compactSpeech(preview.storeName, 80)}.`,
    `Delivery is to ${compactSpeech(preview.addressSummary, 100)}.`,
    `Payment is ${compactSpeech(preview.paymentSummary, 80)}.`,
    preview.scheduledTime ? `Delivery is scheduled for ${formatScheduledTime(preview.scheduledTime)}.` : "",
    preview.workBenefitSummary
      ? `A work benefit is available: ${compactSpeech(preview.workBenefitSummary, 140)}. It is not applied. Say use work benefit to stop, or use the exact phrase to choose the named card.`
      : "",
    preview.requiresPinHandoff
      ? "This delivery requires a PIN at handoff; the exact phrase accepts that requirement."
      : ""
  ].filter(Boolean);
  const optional = [
    preview.etaSummary ? `Estimated delivery is ${compactSpeech(preview.etaSummary, 60)}.` : "",
    preview.priceBreakdown ? `DoorDash breakdown: ${compactSpeech(preview.priceBreakdown, 220)}.` : "",
    preview.promotionSummary ? `Applied savings: ${compactSpeech(preview.promotionSummary, 120)}.` : ""
  ].filter(Boolean);
  const approvalInstruction = channel === "voice" && !preview.workBenefitSummary && !preview.requiresPinHandoff
    ? `To confirm this active preview, say yes. You can also use the transaction-specific phrase: ${phrase}.`
    : `To confirm, say exactly: ${phrase}.`;
  const approval = `The exact total is ${formatMoney(preview.totalCents)}, including a ${formatMoney(preview.tipCents)} Dasher tip. ${approvalInstruction}`;
  const maximum = 1150;
  let before = [...essential, ...optional].join(" ");
  while (`${before} ${approval}`.length > maximum && optional.length > 0) {
    optional.pop();
    before = [...essential, ...optional].join(" ");
  }
  if (`${before} ${approval}`.length > maximum) {
    before = before.slice(0, Math.max(0, maximum - approval.length - 1)).trimEnd();
  }
  return `${before} ${approval}`.trim();
}

function liveConfirmationPhrase(preview: OrderPreview, code: string): string {
  const start = preview.workBenefitSummary
    ? `Charge ${compactSpeech(preview.paymentSummary, 60)} and place order`
    : "Place order";
  const pin = preview.requiresPinHandoff ? " and accept PIN handoff" : "";
  return `${start} ${code} for ${formatMoney(preview.totalCents)}${pin}`;
}

function compactSpeech(value: string, maximum: number): string {
  const normalized = normalizeText(value);
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function looksLikeOrderRequest(text: string): boolean {
  return /\b(order|reorder|previous|last\s+(?:order|meal|tuesday)|what\s+i\s+had|get\s+me|place\s+my)\b/i.test(text);
}

function isCancel(text: string): boolean {
  return /^(cancel|never mind|nevermind|stop order|abandon)$/i.test(normalizeCommand(text));
}

function isReset(text: string): boolean {
  return /^(start over|new order|reset)$/i.test(normalizeCommand(text));
}

function isNegativeResponse(text: string): boolean {
  return /^(?:no|no thanks|not now|wait|hold on)$/i.test(normalizeCommand(text));
}

function normalizeCommand(text: string): string {
  return normalizeText(text).replace(/[.,!?;:]+$/g, "").trim();
}

function reliableCallId(value: string | undefined): string | undefined {
  const normalized = normalizeText(value ?? "");
  if (!normalized || /^none|null|undefined$/i.test(normalized)) return undefined;
  return normalized.slice(0, 200);
}

function canStartFreshCall(stage: PhoneOrderState["stage"]): boolean {
  return ["ready", "preparing", "awaiting_confirmation", "demo_confirmed", "abandoned"].includes(stage);
}

function canChangePurchaseRun(stage: PhoneOrderState["stage"]): boolean {
  return stage !== "submitting" && stage !== "reconciliation_required";
}

function normalizeConfirmation(text: string): string {
  return normalizeText(text).toLowerCase().replace(/[.,!?]+$/g, "");
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fixedDoorDashIntent(request: string): string {
  const safe = normalizeText(request).replace(/[\r\n]/g, " ").slice(0, 160);
  return `Summary: Help the account owner prepare a food order\nuser prompt/purpose: "${safe.replace(/["\\]/g, "")}"`;
}

function validatePreview(preview: OrderPreview, limitCents: number): void {
  const parsed = StoredPreviewSchema.safeParse(preview);
  if (!parsed.success) throw Object.assign(new Error("Order provider returned an invalid preview"), { code: "PROVIDER_SCHEMA_MISMATCH" });
  if (preview.providerMode === "live" && !preview.providerSnapshotHash) {
    throw Object.assign(new Error("Live order preview is missing its canonical provider snapshot hash"), { code: "PROVIDER_SNAPSHOT_MISSING" });
  }
  if (preview.totalCents > limitCents) throw Object.assign(new Error("Order total exceeds the configured limit"), { code: "TOTAL_LIMIT_EXCEEDED" });
  if (preview.totalCents !== preview.subtotalCents + preview.feesCents + preview.taxCents + preview.tipCents - preview.creditsCents) {
    throw Object.assign(new Error("Order preview total does not reconcile"), { code: "PREVIEW_TOTAL_MISMATCH" });
  }
}

function canonicalPreview(preview: OrderPreview): string {
  return JSON.stringify({
    providerMode: preview.providerMode,
    providerSnapshotHash: preview.providerSnapshotHash ?? null,
    cartRef: preview.cartRef,
    storeName: preview.storeName,
    itemSummary: preview.itemSummary,
    subtotalCents: preview.subtotalCents,
    feesCents: preview.feesCents,
    taxCents: preview.taxCents,
    tipCents: preview.tipCents,
    creditsCents: preview.creditsCents,
    totalCents: preview.totalCents,
    addressSummary: preview.addressSummary,
    paymentSummary: preview.paymentSummary,
    scheduledTime: preview.scheduledTime ?? null,
    priceBreakdown: preview.priceBreakdown ?? null,
    promotionSummary: preview.promotionSummary ?? null,
    workBenefitSummary: preview.workBenefitSummary ?? null,
    requiresPinHandoff: preview.requiresPinHandoff ?? false
  });
}

function formatScheduledTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(value));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isAmbiguousError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "ambiguous" in error && error.ambiguous === true)
    || /(?:OUTCOME_UNKNOWN|CREATION_UNCERTAIN)$/.test(errorCode(error) ?? "");
}

function approvalHash(preview: OrderPreview, code: string, expiresAt: string): string {
  return `sha256:${crypto.createHash("sha256").update(`${canonicalPreview(preview)}|${code}|${expiresAt}`).digest("hex")}`;
}

function parseSubmission(value: unknown): OrderSubmission {
  const parsed = OrderSubmissionSchema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error("Order provider returned an invalid result"), { code: "PROVIDER_SCHEMA_MISMATCH" });
  return parsed.data;
}
