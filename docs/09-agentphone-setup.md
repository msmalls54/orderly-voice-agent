# AgentPhone SMS setup and scored rollout

## Hard separation warning

**Do not point the existing Grandpa Food/Richie AgentPhone agent at this service.** AgentPhone delivers a per-agent webhook to exactly one endpoint, so updating that agent would redirect its messages away from the running Railway service.

The live setup uses a separate Orderly agent and the account's previously unused spare number. The Grandpa Food agent, its number assignment, webhook, and Railway service were not changed, disabled, or redeployed. No live SMS was sent.

## Verified live setup receipt

Verified on September 3, 2026 without displaying identifiers, telephone numbers, or credentials:

- AgentPhone account API access is working.
- The existing 10DLC campaign status is `approved`.
- The account has two active SMS numbers.
- One active number is attached to the Grandpa Food agent.
- The existing active, outbound-enabled spare is attached to a new, separate Orderly agent.
- Orderly's per-agent webhook is active at the deployed `/sms` endpoint with `contextLimit: 0`. Use a 30-second timeout for the phone-ordering prototype; live mutations must move to a durable asynchronous worker before purchase is enabled.
- AgentPhone's signed provider self-test reached the endpoint and received HTTP 200.
- `LIVE_SMS_ENABLED=false` and `SMS_OUTBOUND_VERIFIED=false`; no handset message was sent.

This setup did not purchase a third number and did not modify the Grandpa Food lane. The remaining SMS gate is the supervised handset round trip in `10-agentphone-handset-test.md`.

## Reliability and complexity by part

Scores are planning estimates. Reliability 10 means the component is highly dependable in a live demonstration. Complexity 10 means it is difficult or risky to set up and debug.

| Part | Reliability | Complexity | Current state | Decision |
|---|---:|---:|---|---|
| Separate AgentPhone agent | 9 | 3 | Created and verified | Complete |
| Separate attached number | 9 | 2 | Former spare attached to Orderly only | Complete |
| Per-agent signed webhook | 9 | 4 | Active at 30 seconds; signed provider self-test passed | Complete |
| Raw-body HMAC + timestamp check | 10 | 4 | Tested | Core |
| Sender and receiving-number allowlists | 10 | 2 | Tested | Core |
| Durable encrypted inbound queue | 8 | 5 | Tested on SQLite | Core, single replica |
| Durable encrypted outbound outbox | 8 | 6 | Tested | Core |
| Crash/ambiguous-send protection | 9 | 6 | Tested | Core; never blind-retry |
| STOP/START and queued-message cancellation | 9 | 4 | Tested | Core |
| Administrator alert through same provider | 6 | 3 | Tested with mock | Core fallback; correlated provider failure remains |
| Health/readiness endpoints | 9 | 3 | Local tests and live checks passed; outbound stays red by policy | Core |
| Real handset round trip | 7 | 4 | Not run | Supervised gate |
| SQLite on one persistent volume | 8 | 4 | Code ready | Event-sized deployment only |
| Shared Postgres/queue for replicas | 9 | 8 | Not built | Production scale gate |
| Shared-number webhook gateway | 6 | 8 | Excluded | Build only if explicitly requested |
| Shared call/SMS order state | 8 | 6 | Deployed in encrypted SQLite with optimistic concurrency | Hackathon core |
| Single-use purchase approval ledger | 9 | 7 | Tested; purchase gate remains off | Live prerequisite |
| DoorDash runtime bundle | 9 | 4 | v0.2.4 checksum-pinned and executable on Railway | Ready for account canary |
| DoorDash account and live adapter | 5 | 8 | Not connected or enabled | Remaining blocker |

## What is implemented

- `AgentPhoneSmsProvider` uses the documented `POST /v1/messages` contract.
- `/sms` captures raw bytes, validates the HMAC with a timing-safe comparison, rejects stale timestamps, validates `X-Webhook-ID`, and parses a strict text-message schema.
- Signed voice events are strictly validated, restricted to the configured number and allowlisted callers, deduplicated by delivery ID, and answered with sanitized speech. Low-confidence speech cannot confirm an order. Group and media-only messages are acknowledged and ignored.
- Unknown senders receive no queued work and no reply.
- Phone numbers and message bodies are encrypted in SQLite using AES-256-GCM. Lookup values use a keyed HMAC; logs contain only masked numbers.
- Inbound and outbound workers use leases. An interrupted send becomes `ambiguous` and cannot be resent automatically.
- Only an explicitly rejected transient rate limit may retry. Timeouts, `5xx`, and receipt-schema mismatches require reconciliation.
- `STOP` atomically cancels queued ordinary replies. Only the required compliance response can pass after opt-out; `START` resumes service.
- Health endpoints separate liveness, webhook readiness, outbound handset readiness, and queue failures/age.

The deployed phone handler shares encrypted state across voice and SMS, produces a deterministic mock preview, rejects vague assent, and consumes an exact short-lived confirmation only once. It performs no model call, DoorDash account action, purchase, browser operation, or outbound SMS while the live gates are off.

## New-agent setup sequence and retained runbook

The approved setup steps below are complete through webhook verification. Keep them as the reproducible runbook; the final handset gate remains intentionally pending.

1. In the AgentPhone dashboard, record the existing Grandpa Food agent name and ID privately so it can be avoided. Do not copy it into this repository or logs.
2. Create a distinctly named Orderly agent only after approval.
3. Re-read the number inventory and confirm the same active spare remains unattached and outbound-enabled. Do not provision a third number.
4. Attach only that spare number to the new Orderly agent.
5. Re-read registration and number status after attachment. The account campaign is currently approved, but the handset gate must confirm actual outbound delivery.
6. Deploy this service with one persistent volume and set `DATABASE_PATH` to that volume. SQLite supports one application replica; do not horizontally scale this version.
7. Put the new values from `.env.example` into encrypted deployment secrets. Keep `LIVE_SMS_ENABLED=false`, `SMS_OUTBOUND_VERIFIED=false`, and `AGENTPHONE_WEBHOOK_SETUP_ENABLED=false`.
8. Inspect `GET /v1/agents/{new_agent_id}/webhook`. Compare its agent ID and URL to the approved setup record. The code's inspection method discards the returned signing secret instead of logging or returning it.
9. Deliberately create/update the new per-agent webhook to `https://<new-service>/sms`, with `contextLimit: 0` and a short timeout. Each update rotates the signing secret; store the returned secret immediately in the deployment secret manager.
10. Restart the service with the stable secret, re-read the webhook, verify the exact URL/status, then set `AGENTPHONE_WEBHOOK_REMOTE_VERIFIED=true`. **Complete.**
11. Confirm `/health/live`, `/health/webhook`, and `/health/queue`. **Complete.** `/health/outbound` remains red until the full handset test passes, as intended.

The application never auto-configures a webhook at startup. The typed setup method requires both `AGENTPHONE_WEBHOOK_SETUP_ENABLED=true` and `AGENTPHONE_AGENT_SEPARATION_CONFIRMED=true`, reads the current webhook first, and refuses the update if its ID changed since operator review.

## Storage and scaling boundary

For the hackathon, use a single service replica and a mounted persistent volume. A local filesystem without a persistent mount is not durable across redeployment.

Before real users or multiple replicas, move inbound jobs, idempotency records, contact preferences, and the outbox into a shared transactional database. Add a queue with visibility timeouts, independent administrator paging, encrypted backups, retention/deletion jobs, and per-tenant authorization. Keep AgentPhone receipts separate from business-action idempotency: delivery failure must never replay an order or payment.

## Safe environment inspection

Run `npm run check:env`. It prints only `NAME=[set]` or `NAME=[missing]`. It must never be changed to display values. Production secrets belong only in the deployment platform's encrypted secret store.

## Current provider facts to recheck before launch

- Per-agent webhook routing and secret rotation.
- New-number 10DLC/campaign assignment and outbound capability.
- Sending limits and billing balance.
- Delivery-status fields/events available for this agent and channel.
- First-message brand, opt-in, and STOP language.
- Whether any provider-level opt-out behavior supplements the service's durable STOP handling.

Official references: [webhooks](https://docs.agentphone.ai/documentation/guides/webhooks), [messages](https://docs.agentphone.ai/documentation/guides/messages), [error handling](https://docs.agentphone.ai/documentation/reference/error-handling), [rate limits](https://docs.agentphone.ai/documentation/reference/messaging-rate-limits), and [phone numbers](https://docs.agentphone.ai/documentation/guides/phone-numbers).
