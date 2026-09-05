# Checkout and order state machine

## States

```text
NEW
  -> DISCOVERING
  -> DRAFTED
  -> PREVIEWED
  -> AWAITING_CONFIRMATION
  -> DEMO_CONFIRMED                 buildathon terminal state

Future paid path only:
AWAITING_CONFIRMATION
  -> APPROVED
  -> SUBMITTING
  -> PLACED
  -> COMPLETED | CANCELLED

Any pre-submit state -> ABANDONED | FAILED
SUBMITTING -> RECONCILIATION_REQUIRED on timeout/ambiguous response
RECONCILIATION_REQUIRED -> PLACED | FAILED | MANUAL_REVIEW
```

`DEMO_CONFIRMED` has no transition to `SUBMITTING` in the buildathon build.

## Immutable checkout snapshot

The server creates the snapshot from provider data, never from model totals. Canonical fields, in fixed order:

1. `schema_version`
2. `session_id`
3. `provider_mode`
4. `cart_version`
5. `store_ref` and normalized display name
6. Ordered item lines: `item_ref`, display name, quantity, sorted customization labels, line cents
7. `fulfillment_mode`
8. `schedule`
9. `subtotal_cents`
10. `fees_cents`
11. `tax_cents`
12. `tip_cents`
13. `credits_cents`
14. `promo_ref` or null
15. `total_cents`
16. `address_ref` and masked summary
17. `payment_ref` and masked summary
18. `expires_at`
19. cryptographically random four-digit `confirmation_code`

Serialize as UTF-8 JSON with fixed key order and no insignificant whitespace, then compute SHA-256. Store the full snapshot server-side; expose only the `sha256:` digest and masked fields.

## Confirmation language

In a future paid path, after reading the complete snapshot, ask:

> “To confirm this exact order for $26.72, say: Yes, place this order for $26.72, code 4186.”

For the purchase-disabled buildathon demo, ask instead:

> “This is a demo and will not charge you. To confirm this exact preview, say: Confirm demo order 4186.”

Reject “yes,” “sure,” “go ahead,” background speech, a wrong amount/code, or a hash that is not the current session snapshot. Confirmation expires after 90 seconds.

For the buildathon, a successful exact phrase transitions only to `DEMO_CONFIRMED` and the agent immediately says purchasing is disabled.

For a future paid path, do not trust confirmation text invented as an LLM tool argument. Approval must come from a separately authenticated raw transcript/telephony event or an accessible out-of-band control such as DTMF, and be verified by deterministic server logic.

## Invalidation

Any of these events atomically deletes the approval and returns to `DRAFTED` or `PREVIEWED`:

- Add/remove/change item or customization.
- Address, payment, promo, credit, tip, fulfillment, speed, or schedule change.
- Price, fee, tax, ETA, availability, or provider-mode change.
- Snapshot expiry.
- Conversation/session handoff.
- Provider reports an unexpected cart.

The agent must read the new summary and request a fresh confirmation.

## Idempotency and locking

- Every tool request has a server-issued UUID `request_id`; replay returns the original result or `REPLAY_DETECTED`.
- Every mutation checks `expected_cart_version` and uses compare-and-swap.
- Only one active checkout lock exists per DoorDash account and cart.
- A future internal submit consumes a one-time approval record and writes `SUBMITTING` before invoking the CLI.
- The submit idempotency key is `sha256(session_id | checkout_hash | one_time_approval_id)`, stored durably before the provider call.
- A duplicate internal submit with the same key returns existing state and never invokes the CLI again.
- A different submit is blocked while any `SUBMITTING` or `RECONCILIATION_REQUIRED` record exists.

## Ambiguous submission reconciliation

If the process times out, loses its connection, receives malformed JSON, or crashes after invoking submit:

1. Transition to `RECONCILIATION_REQUIRED`.
2. Tell the caller the result is uncertain and not to repeat the order.
3. Block all new submit attempts for that account/cart.
4. Query order status/history using the existing provider/order reference if available.
5. If status is conclusively placed, transition to `PLACED`.
6. If conclusively not placed and the provider proves no charge/order exists, transition to `FAILED`; a completely new preview and human approval are still required.
7. If uncertainty remains, transition to `MANUAL_REVIEW` and escalate to the account owner.

There is no blind retry path.
