import type { MessageHandler } from "./types.js";

/**
 * Safe placeholder for the business-logic layer. It deliberately performs no
 * ordering, purchasing, browsing, or model call. Replace it through dependency
 * injection after the transport passes the supervised handset test.
 */
export class DemoMessageHandler implements MessageHandler {
  readonly retrySafety = "idempotent" as const;

  async handle(_message: { deliveryId: string; idempotencyKey: string; sender: string; body: string }): Promise<string> {
    return "Orderly: Thanks for texting this supervised demo. It did not place or change an order. Reply STOP to unsubscribe.";
  }
}
