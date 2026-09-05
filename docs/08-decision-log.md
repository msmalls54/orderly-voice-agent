# Decision log

| Date | Decision | Evidence or reason | Status / revisit trigger |
|---|---|---|---|
| 2026-09-03 | Treat the participant's DoorDash beta access as authorized for a single-account hackathon prototype. | Participant explicitly confirmed the organizer/provider invited live beta use. | Accepted; does not authorize credential sharing or public multi-user use. |
| 2026-09-03 | Keep purchase disabled throughout this task and the stage demo. | Original brief requires no paid order without explicit transaction approval and says purchase is disabled by default. | Revisit only in a separate test with a fresh preview and exact approval. |
| 2026-09-03 | Use deterministic fixtures for the 150-minute core. | Current Windows host cannot run the official macOS ARM64/Linux amd64 binary; WSL and Docker are unavailable. | Replace with live read-only data only on a supported authenticated host. |
| 2026-09-03 | Do not copy the earlier Grandpa Orders implementation into the event project tonight. | Public event material does not answer prebuilt-code or reuse rules. | Revisit after an organizer answers the six questions in `01-hackathon-rules.md`. |
| 2026-09-03 | Use ElevenLabs' hosted low-latency model path. | Fewer event-day components; ElevenLabs documents hosted models and cascading. | Revisit only if tool-call quality fails rehearsals. |
| 2026-09-03 | Select native `gemini-3.7-flash` as Orderly's primary conversational model. | User selected the current speed-first Gemini option after comparing reliability and latency; native ElevenLabs support avoids a custom endpoint. | Keep cascading enabled; revisit only if representative tool-call tests fail. |
| 2026-09-03 | Make Twilio optional. | A paid number and carrier path add failure modes; browser mic preserves the voice story. | Use Twilio only if already active and tested before the timed build. |
| 2026-09-03 | Keep Linkup out of the core ordering path. | Current DoorDash data should come from DoorDash; web results are not authoritative for availability or price. | Add only for official-domain policy/allergen/support links. |
| 2026-09-03 | Bind approval to an immutable preview hash and one-time phrase. | Prevents stale, altered, replayed, or ambiguous voice approval. | Non-negotiable for any future live submit. |
| 2026-09-03 | Never retry an ambiguous submit automatically. | A timeout can conceal a successful purchase; retry could duplicate it. | Query status or hand off to support. |
| 2026-09-03 | Be demo-ready by 4:00 PM despite the 4:30/5:00 schedule discrepancy. | The primary Luma and secondary organizer listings disagree on showcase timing. | Conservative event-day deadline. |

## Open decisions

- Whether code, schemas, and fixtures may be prepared before the event.
- Whether Codex is an allowed development tool.
- Whether Lovable, ElevenLabs, and Linkup are mandatory or optional.
- Team size, submission format, judging rubric, and demo duration.
- Whether DoorDash has a hackathon-specific build, support channel, token policy, or prize requirement.
- Which supported macOS/Linux machine will run live read-only CLI checks.
