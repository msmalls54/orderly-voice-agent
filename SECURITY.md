# Security policy for the prototype

## Scope

This repository is an event prototype, not a production ordering service. It is designed for one authorized beta account. One supervised transaction was completed for the hackathon demonstration; purchase capability is locked by default outside an explicitly authorized test.

## Hard controls

- Secrets and DoorDash credentials stay server-side and out of version control.
- Tool calls require authentication, strict JSON validation, body limits, rate limits, and state-transition checks.
- Checkout approval is valid only for the exact immutable preview hash, one session, one request, and a short expiry.
- Any change to merchant, items, quantities, substitutions, address, card, fulfillment, schedule, fee, credit, tip, or total invalidates approval.
- Submit requests are serialized per account. An ambiguous result is never retried blindly.
- Menu text, web results, transcripts, and model output are untrusted input.
- Logs use request IDs and masked references; raw tokens, full addresses, full payment data, and audio are excluded.
- Unsafe, unsupported, regulated, or age-restricted categories fail closed.
- A caregiver/support handoff is available without exposing secrets in the voice session.

## Reporting

For this hackathon, report a suspected issue privately to the project owner. Do not include credentials, full personal data, or a live exploit in screenshots or public demos. Revoke exposed tokens and stop the tunnel immediately.

## Production gates

Before any multi-user or live-charge release: current provider permission, legal/privacy review, durable encrypted storage, tenant isolation, deletion workflows, abuse controls, monitoring, incident response, dependency scanning, penetration testing, accessibility testing with target users, and rollback drills are required.
