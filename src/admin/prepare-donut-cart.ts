import { loadConfig } from "../config.js";
import { DoorDashCartBackend } from "../order/doordash-cart-backend.js";
import { CryptoBox } from "../security/crypto-box.js";
import { SmsStore } from "../store/store.js";

const config = loadConfig();

if (config.PURCHASE_ENABLED) throw new Error("Refusing cart preparation while purchasing is enabled");
if (!config.DD_CLI_ACCESS_TOKEN || !config.DOORDASH_ACCOUNT_CONNECTED_VERIFIED) {
  throw new Error("DoorDash read-only connection is not verified");
}

const store = new SmsStore(
  config.DATABASE_PATH,
  new CryptoBox(config.DATA_ENCRYPTION_KEY, config.PII_HASH_KEY)
);

try {
  const preparationStatus = store.cartPreparationStatus();
  if (preparationStatus && preparationStatus !== "uncertain") throw new Error("A cart preparation is already active");
  if (preparationStatus === "uncertain" && !config.DOORDASH_DEMO_CART_UUID) {
    throw new Error("An uncertain cart must be configured and reviewed before it can be cleared");
  }
  const backend = new DoorDashCartBackend(config, undefined, store);
  const preview = await backend.prepareReorder({
    request: "Order 12 regular donut holes and two apple fritters from My Happy Donut.",
    intent: "Summary: Prepare and verify the account owner's exact supervised Orderly demo cart without submitting it\nuser prompt/purpose: \"Order 12 regular donut holes and two apple fritters from My Happy Donut\""
  });
  const uncertaintyReconciled = preparationStatus === "uncertain"
    ? store.resolveUncertainCartPreparationAfterReview()
    : false;
  if (preparationStatus === "uncertain" && !uncertaintyReconciled) {
    throw new Error("The verified cart could not clear the uncertainty hold");
  }
  console.log(JSON.stringify({
    ok: true,
    cartRef: preview.cartRef,
    storeName: preview.storeName,
    itemSummary: preview.itemSummary,
    netTotalBeforeTipCents: preview.subtotalCents,
    tipCents: preview.tipCents,
    totalCents: preview.totalCents,
    etaSummary: preview.etaSummary ?? null,
    priceBreakdown: preview.priceBreakdown ?? null,
    promotionSummary: preview.promotionSummary ?? null,
    workBenefitAvailable: Boolean(preview.workBenefitSummary),
    requiresPinHandoff: Boolean(preview.requiresPinHandoff),
    addressVerified: true,
    paymentVerified: true,
    uncertaintyReconciled,
    purchaseSubmitted: false
  }));
} catch (error) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "CART_PREPARATION_FAILED";
  console.error(JSON.stringify({ ok: false, code, purchaseSubmitted: false }));
  process.exitCode = 1;
} finally {
  store.close();
}
