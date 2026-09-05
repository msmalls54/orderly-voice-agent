# Orderly — 90-second live demo script

Replace `[DELIVERY TIME]` with the configured scheduled-delivery time before rehearsing. The caller does not need to memorize an exact command; the request below is simply the cleanest version for a noisy room.

## Before going onstage

- Put the phone on speaker and turn media/ringer volume all the way up.
- Open the deck to the problem slide, with the sanitized transcript and receipt assets ready on the next slide.
- Confirm the fresh scheduled preview uses tomorrow at `[DELIVERY TIME]`, the event delivery location, the expected masked payment method, and a total you accept.
- Do not display a phone number, delivery address, card details, access token, or full order reference.
- Once the agent begins submitting, never repeat “yes” or restart the call. A processing response must be reconciled, not retried.

## The live 90 seconds

| Time | Speaker | Script / action |
|---:|---|---|
| 0:00–0:12 | Presenter | “Food-delivery apps assume you can see a screen, navigate menus, and hit tiny buttons. For many older adults, that is the problem. Orderly turns the entire experience into a normal phone call.” |
| 0:12–0:18 | Presenter | “I’m not opening DoorDash. I’m just calling Orderly.” Dial the dedicated number and switch to speaker. |
| 0:18–0:26 | Caller | After the greeting: “Get me 12 donut holes and two apple fritters from My Happy Donut.” |
| 0:26–0:48 | Orderly | Expected behavior: Orderly checks the real cart, reads the items, scheduled time, delivery destination summary, masked payment method, live total, and tip, then asks for confirmation. Do not talk over the readback. |
| 0:48–0:52 | Caller | After the complete total and confirmation question: “Yes.” |
| 0:52–1:06 | Orderly | Expected behavior: one submission begins. Orderly reports either that the order is scheduled/placed or that it is processing. If it says processing, do not approve or submit again. |
| 1:06–1:20 | Presenter | Advance to the proof slide. “That was a real DoorDash workflow with no app screen. AgentPhone handled the phone connection, ElevenLabs gave Orderly its voice, our server verified the exact checkout, and DoorDash’s official CLI submitted it once.” |
| 1:20–1:30 | Presenter | Point to the transcript and receipt. “The result is auditable: one verbal approval, one submission, zero retries, and zero duplicates. Orderly makes food delivery simpler without making the purchase invisible.” |

## If the judges ask what is technically happening

“The call is the user interface. AgentPhone carries the phone conversation, ElevenLabs supplies the voice, and Orderly’s server owns the transaction state. It gets a live DoorDash preview, binds the items, destination, payment summary, tip, total, and scheduled time into one approval, and only then lets the official DoorDash CLI submit once.”

## If anything stalls

- **The request is split across speech turns:** finish the sentence naturally. Do not say “start over.”
- **The agent asks what you want again:** repeat only, “Twelve donut holes and two apple fritters from My Happy Donut.”
- **The total changes:** let Orderly finish the new readback. Say “yes” only if you accept that newly stated total.
- **Orderly says processing:** stop. Say, “The order is being reconciled, so the system will not risk a duplicate.” Then advance to the existing proof slide.
- **The phone path fails completely:** advance immediately to the sanitized transcript and receipt. Say, “Venue connectivity failed, so here is the same flow completed live earlier today: one call, one approval, one real DoorDash order.”

## Closing line

“Orderly uses voice where voice is essential: not as narration on top of an app, but as the entire accessible customer experience.”
