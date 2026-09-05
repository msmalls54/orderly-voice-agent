# MVP scope, reliability/complexity scores, and 150-minute plan

## Scoring definition

- **Reliability 1–10:** 10 means highly dependable in a noisy live demo with minimal external failure risk.
- **Complexity 1–10:** 10 means difficult, time-consuming, or risky to finish and debug in the 150-minute window.

Scores are planning estimates, not measured service-level data. Prefer high reliability and low complexity for the core path.

## Component scorecard

| Part | Reliability | Complexity | Event decision | Why |
|---|---:|---:|---|---|
| Product story: phone ordering for seniors | 9 | 2 | Core | Clear problem, memorable hook, easy to explain |
| Minimal Lovable judge screen | 9 | 3 | Core | Makes voice state and safety visible; little interaction |
| ElevenLabs browser microphone | 9 | 2 | Core fallback | Avoids telephony setup failure while preserving voice |
| Imported Twilio inbound number | 7 | 4 | Core if ready | Strong “no app” proof, but provider/account setup can fail |
| ElevenLabs native Gemini 3.7 Flash | 8 | 2 | Core | Current speed-first choice with native tool support and no custom model endpoint |
| Custom OpenAI `gpt-5.4-mini` runtime | 7 | 7 | Post-event/stretch | Strong tools/structured output, but adds a server and latency |
| Authenticated webhook tool gateway | 8 | 5 | Core | Required boundary; moderate setup and debugging |
| Deterministic mock ordering adapter | 10 | 2 | Core | Removes provider/account/price variance from judging |
| “Last Tuesday” mock history lookup | 9 | 3 | Core | High-value natural-language moment with fixed data |
| Three-choice restaurant/menu ranking | 9 | 3 | Core | Senior-friendly and easy to demonstrate |
| Immutable checkout summary/hash | 9 | 5 | Core | Central safety story; manageable if fields are fixed |
| Exact verbal confirmation, demo-only | 8 | 4 | Core | Shows safety without permitting payment |
| Caregiver/support escalation response | 8 | 3 | Core script | Good accessibility behavior; no live transfer needed |
| Linkup fast public-web lookup | 8 | 3 | Stretch | Useful partner integration at roughly sub-second search latency |
| Live DoorDash store/menu read-only | 6 | 6 | Stretch | Requires supported host, auth, current schemas, and network |
| Live DoorDash history/reorder read-only | 5 | 7 | Stretch | Adds sensitive data handling and account-specific variance |
| Live DoorDash cart + preview | 5 | 8 | Cut unless everything else is green | Mutating cart and parsing totals add failure modes |
| Remote headless DoorDash token lane | 4 | 8 | Post-event | Token expiry/auth bootstrap and public endpoint hardening |
| Real DoorDash order submission | 2 | 10 | Excluded | Destructive, non-idempotent, unsafe and unnecessary for judging |
| Redis/Postgres durable state | 8 | 7 | Post-event | Correct scale choice, wrong 150-minute tradeoff |
| Fully mocked backup recording | 10 | 2 | Core | Last-resort proof if the venue network or telephony fails |

## Recommended scope lock

### Core

- One ElevenLabs agent.
- Browser microphone first; Twilio number if existing credentials and number are ready.
- Three exposed tools: `find_choices`, `get_previous_order`, and `draft_or_preview`.
- Deterministic fixture data.
- Exact, short confirmation phrase bound to an immutable preview.
- No paid or live-mutating DoorDash capability.
- Minimal Lovable screen showing current state, mock/live marker, checkout hash suffix, and safety gate results.

### Stretch, in order

1. Linkup `fast` search against a strict official-domain allowlist for a public restaurant phone or allergen-policy link.
2. Live DoorDash store search/menu read-only on a supported, already authenticated host.
3. Twilio inbound number if the web microphone path already works.

### Explicit cuts

- Real checkout.
- Multiple restaurants in one order.
- Grocery, pickup, scheduled orders, priority delivery, group carts, work benefits, or promos.
- Custom LLM/WebSocket brain.
- Persistent user accounts, memory, or analytics.
- More than three spoken choices.
- Free-form “do anything” tool or shell access.

## 150-minute event budget

| Clock | Minutes | Outcome / hard gate |
|---|---:|---|
| 2:00–2:05 | 5 | Record organizer answers; lock core scope and whether prior design may be used |
| 2:05–2:20 | 15 | Create the event Lovable project and restrained judge screen |
| 2:20–2:40 | 20 | Configure ElevenLabs voice, short system prompt, browser microphone |
| 2:40–3:00 | 20 | Create the tiny tool gateway and load deterministic fixtures |
| 3:00–3:20 | 20 | Wire the three core tools with auth, schemas, timeouts, and redaction |
| 3:20–3:35 | 15 | Implement preview hash, expiry, mutation invalidation, and demo confirmation |
| 3:35–3:45 | 10 | Import/test Twilio number; abandon immediately if blocked and keep web mic |
| 3:45–3:55 | 10 | Add Linkup fast official-domain lookup only if core is green |
| 3:55–4:00 | 5 | Freeze a known-good core build; save screenshots/backup clip |
| 4:00–4:15 | 15 | Negative tests: vague assent, changed tip, duplicate call, injection, timeout |
| 4:15–4:25 | 10 | Two timed 75-second rehearsals; cut any unreliable sentence or click |
| 4:25–4:30 | 5 | Final freeze, close distracting windows, open backup path |

## Stop rules

- If Twilio is not connected within 10 minutes, use the browser microphone.
- If a live DoorDash read-only call takes more than 15 minutes to authenticate or normalize, switch to mock and do not revisit it.
- If Linkup is not returning one small cited result within 10 minutes, remove it from the live path and mention it as prepared stretch work.
- If any late change breaks the 4:00 build, revert to the last known-good demo; do not live-debug during judging.
- Never trade the deterministic fallback for an unverified integration.

## Demo success criteria

- Voice starts within five seconds from call/widget connection.
- Agent asks one question at a time and speaks no more than three choices.
- “Last Tuesday” returns the fixture order and applies “without onions.”
- Vague assent does not advance the state.
- Final readback includes restaurant, items/customizations, subtotal/fees/tax/tip/total, masked address, and masked payment method.
- Changing any checkout field invalidates the old confirmation hash.
- Duplicate tool calls do not duplicate a state transition.
- The screen clearly says `MOCK DATA` and `PURCHASE DISABLED`.
- End-to-end judge interaction finishes in 75 seconds.
- Backup demo works without Twilio, DoorDash, Linkup, or venue Wi-Fi.

## Tonight / event / unknown checklist

### Safe to prepare tonight

- Confirm both event registrations.
- Put provider keys in a password manager; create no secret-bearing project file.
- Decide on a trusted macOS ARM64 or Linux AMD64 host for `dd-cli`.
- Verify the CLI archive checksum and practice `--help`/login on that host without saving output.
- Confirm an existing Twilio number is purchased and voice-capable; do not purchase a new number without reviewing cost.
- Create the ElevenLabs account and identify the agent/privacy/phone-number screens.
- Save the prompt, schemas, fixtures, pitch, and demo script from this packet.
- Charge laptop, pack charger/headphones/hotspot, and export an offline backup.

### Must wait for event or organizer answer

- Competition Lovable project and source implementation if onsite creation is required.
- Reuse of code from any prior project.
- Submission/publishing steps.
- Any paid API test or phone-number purchase not already approved.
- Any DoorDash cart mutation until the supported host passes read-only checks.

### Unknown pending organizer confirmation

- Start-from-scratch/reuse rule.
- Codex/external-agent policy.
- Required vs optional use of each partner.
- Judging criteria and presentation length.
- ElevenLabs prize eligibility details.
- Team size and submission mechanism.
