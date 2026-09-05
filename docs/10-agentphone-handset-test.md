# Supervised AgentPhone handset test

This checklist is the only path to `SMS_OUTBOUND_VERIFIED=true`. It applies to the new Orderly agent and number only.

## Preconditions

- The owner explicitly authorizes this exact test, its expected message count, and any provider cost.
- The dashboard shows a separate Orderly agent and separate number. Neither ID matches Grandpa Food/Richie.
- Outbound US SMS/10DLC status and sending limits have been reviewed.
- The new service runs as one replica with a mounted persistent volume.
- New secrets are stored in the deployment secret manager; none appear in source, prompts, screenshots, or logs.
- `PURCHASE_ENABLED=false` and all ordering/business-action adapters are mocked.
- `AGENTPHONE_WEBHOOK_SETUP_ENABLED=false` after the deliberate setup step.
- `AGENTPHONE_WEBHOOK_REMOTE_VERIFIED=true` only after a current GET confirms the new URL.
- `LIVE_SMS_ENABLED=true` only for the authorized test window.
- `SMS_OUTBOUND_VERIFIED=false` at the start.
- `/health/live`, `/health/webhook`, and `/health/queue` are green; outbound readiness is expected to remain red.

## Round-trip test

Record timestamps and redacted message IDs, never full telephone numbers or bodies.

1. From an allowed real mobile handset, text a harmless phrase to the new Orderly number.
2. Confirm AgentPhone sends a signed webhook to the new service and receives HTTP 200 quickly.
3. Confirm exactly one encrypted inbound job is committed before processing begins.
4. Confirm the mock business handler runs once and queues one outbound reply.
5. Confirm AgentPhone accepts the outbound API request.
6. Confirm the intended handset actually receives the correct Orderly reply. Provider acceptance alone is insufficient.
7. Reply again from the handset and confirm a second signed inbound webhook reaches the new service.
8. Replay the first fake test webhook ID in a controlled local/test request; confirm it creates no duplicate reply or action. Do not replay carrier traffic against production.
9. Send `STOP`; confirm the opt-out response arrives and any previously queued ordinary reply is cancelled.
10. Send an ordinary message; confirm the service stays silent.
11. Send `START`; confirm the resume response arrives, then verify one harmless round trip.
12. Exercise one mock provider rejection and one mock timeout in the non-live test environment. Confirm the business action is not repeated, the outbox status is visible, and the administrator alert behavior matches the runbook.
13. Inspect structured logs and health output. Confirm phone numbers are masked and no key, webhook secret, raw body, full message, or authorization header appears.
14. Restart the application with a queued mock message and confirm the durable queue resumes from the persistent volume.

## Verification gate

Set `SMS_OUTBOUND_VERIFIED=true` only when all six user-required observations are evidenced:

1. The new service sent the test message.
2. The intended handset received it.
3. The handset replied.
4. The signed inbound webhook reached the new service.
5. The service sent the correct second response.
6. Duplicate webhook delivery did not create a duplicate reply or action.

If any observation is missing, keep the flag false and record the blocker. A green API receipt is not a handset receipt.

## Closeout

- Return `LIVE_SMS_ENABLED=false` unless the owner separately approves continued live use.
- Keep `PURCHASE_ENABLED=false`.
- Stop temporary tunnels.
- Rotate temporary webhook/API credentials if they were exposed to a local test environment.
- Confirm the Grandpa Food/Richie webhook and Railway health are unchanged using read-only checks only.
- Record message count and cost without including private message text or phone numbers.

