# Demo and fallback script

## 15-second pitch

Orderly lets an older adult order food using the interface they already know: a phone call. It can recall a previous meal, explain only a few choices, and read back every charge before a one-time confirmation. The demo is deterministic and purchase-free, with the same guarded interface reserved for DoorDash's live beta.

## 80-second primary demo

| Time | Action and words |
|---:|---|
| 0-8s | Presenter: "Ordering apps can be visually dense. Orderly turns the flow into a calm conversation without weakening checkout safety." |
| 8-18s | Caller: "Orderly, order what I had last Tuesday." |
| 18-30s | Agent: "Last Tuesday you had a chicken-and-rice bowl from Harbor Bowl Kitchen, with no onions. Would you like the same meal?" |
| 30-36s | Caller: "Yes, but make sure there are no onions." |
| 36-55s | Agent: "I have one chicken-and-rice bowl, no onions, delivered to your Home address, paid with Visa ending 4242. The subtotal is $18.50, fees and tax are $4.72, the tip is $3.50, and the exact total is $26.72." |
| 55-65s | Agent: "This is a demo and will not charge you. To confirm this exact preview, say: Confirm demo order 4186." |
| 65-70s | Caller: "Confirm demo order 4186." |
| 70-76s | Agent: "Demo confirmed. No purchase was placed." |
| 76-80s | Presenter points to the screen: "The checkout hash, one-time phrase, and purchase-disabled control make the voice approval auditable." |

The Lovable screen should show `MOCK — NO PURCHASE`, the current state, the exact total, and an event log containing request IDs but no secrets or full personal data.

## Accessibility behavior to demonstrate

- Short sentences and one decision per turn.
- Repeat on demand without penalty: "I can say that again more slowly."
- No more than three choices at once.
- Explicit currency amounts; never say only "about twenty-seven dollars."
- Address label and payment last four instead of full sensitive values.
- A visible transcript and large-text state card on the judge screen.
- "Talk to a person" available from every non-terminal state.

## Fallback ladder

### A — Phone carrier or Twilio fails

Switch immediately to the ElevenLabs browser microphone. Say: "The agent is the product; the phone network is one interchangeable entry point." Reliability 9/10, complexity 2/10.

### B — ElevenLabs tool webhook fails

Use the Lovable screen to trigger the same deterministic fixture sequence while playing a pre-recorded voice exchange. Keep the `MOCK` badge visible. Reliability 10/10, complexity 2/10.

### C — Venue network fails

Play a locally saved screen recording of the full demo and then show the local checkout-hash/test artifacts. Record this backup only after the working demo is complete. Reliability 10/10, complexity 2/10.

### D — DoorDash live beta fails

Do not troubleshoot it onstage. State: "The official beta integration is isolated behind the same adapter; this event demo disables purchase and uses a deterministic DoorDash-shaped response." Reliability 10/10, complexity 1/10.

### E — Judge asks to place a real order

Say: "The demo environment cannot submit a purchase. In production, we would enable it only after a fresh preview, an exact transaction-bound approval, and account-level limits." Do not change the flag live.

## Judge questions and crisp answers

**Why voice?** It removes menus, small targets, and branching screens while still reading every consequential field aloud.

**Why is it safer than a generic agent?** The model cannot call a submit command directly. A server-side state machine requires an unexpired checkout hash and one-time phrase.

**Is DoorDash actually integrated?** The official beta's current capabilities and host requirements are audited in this packet. The stage demo is mocked and purchase-disabled; live read-only validation is a stretch goal on supported hardware.

**How does it scale?** Keep voice and UI stateless, put account/order locks in a durable store, queue slow adapters, and isolate each merchant provider behind a typed interface.

**What about privacy?** Retain the minimum, mask sensitive values, disable audio storage when available, keep tokens server-side, and give users a deletion/support path.

