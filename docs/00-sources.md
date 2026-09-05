# Source register

Research was performed on **2026-09-03 between 18:35 and 18:55 America/Los_Angeles**. Current pages should be rechecked at the event because the event page and DoorDash CLI both changed on September 3.

## Buildathon

| Source | Authority | What it supports |
|---|---|---|
| [Luma event page](https://luma.com/utyqfarn) | Primary public event page | September 4 venue; two required registrations; partner roles; prizes; public agenda; what to bring |
| [Builder Pub event page](https://builderpub.com/events/non-tech-buildathon-2026) | Organizer page | Beginner audience; 1:00–5:00 PM event; guided build format; registration requirements |
| [Lovable community event listing](https://lovable.dev/community-events) | Build partner listing | “Bring an idea, join a team, or start from scratch”; Lovable is an approachable build tool |
| [Eventbrite listing](https://www.eventbrite.com/e/the-first-non-tech-buildathon-build-with-ai-in-san-francisco-tickets-1998999257591) | Organizer distribution page | Secondary agenda; prize summary; registration language |

Important discrepancy: the current Luma page says build 2:00–4:30 and showcase 4:30–5:15. Builder Pub/Eventbrite material has earlier handoffs. Plan to be fully ready by 4:00.

## DoorDash CLI

| Source | Authority | What it supports |
|---|---|---|
| [Official DoorDash CLI repository](https://github.com/doordash-oss/doordash-cli) | DoorDash OSS | Waitlist gating, supported platforms, feature list, agent use, install flow, headless token method |
| [Official v0.2.4 release](https://github.com/doordash-oss/doordash-cli/releases/tag/v0.2.4) | DoorDash OSS | Latest version on September 3; promo discovery; saved-address search; menu/cart fixes |
| [Official releases index](https://github.com/doordash-oss/doordash-cli/releases) | DoorDash OSS | v0.2.2 Linux/headless introduction and v0.2.3 status/auth changes |
| `LICENSE.txt` bundled in the signed v0.2.4 release | DoorDash-distributed artifact | CLI access terms, personal-account responsibility, credential and data-handling restrictions |

Local receipt: `dd-cli-v0.2.4-linux-amd64.tar.gz` was downloaded to a temporary folder. Published and computed SHA-256 both equaled `37eec0c72bcb663aaf9759ea098d49d9c02266bb895cbbfbadeae41866608dd4`.

## ElevenLabs

| Source | What it supports |
|---|---|
| [Models](https://elevenlabs.io/docs/eleven-agents/customization/llm) | Model-selection factors; hosted models lowest latency; Flash/Haiku/OpenAI mini classes optimized for speed |
| [LLM cascading](https://elevenlabs.io/docs/eleven-agents/customization/llm/llm-cascading) | Built-in retry/fallback behavior and current default cascade |
| [Webhook tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools) | REST tools and supported authentication methods |
| [Twilio native integration](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration/) | Importing a purchased Twilio number; inbound and outbound support |
| [Privacy controls](https://elevenlabs.io/docs/eleven-agents/customization/privacy) | Disable audio saving, retention controls, conversation redaction availability |
| [Zero Retention Mode](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode) | Enterprise-only ZRM details and limitations |
| [ElevenAgents pricing](https://elevenlabs.io/pricing/agents?price.platform=agents_platform) | Included minutes, additional-minute price, and separate LLM/telephony charges |

## Lovable, Linkup, and OpenAI

| Source | What it supports |
|---|---|
| [Lovable–ElevenLabs integration](https://docs.lovable.dev/integrations/eleven-labs) | Lovable can connect a project to ElevenLabs for voice/audio features |
| [Linkup search overview](https://docs.linkup.so/pages/documentation/endpoints/search/overview) | Fast/standard/deep search, structured results, and per-call price |
| [Linkup authentication](https://docs.linkup.so/pages/documentation/platform/authentication) | Bearer API key and `LINKUP_API_KEY` convention |
| [GPT-5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) | Streaming, function calling, structured outputs, snapshots, and current token pricing |

## AgentPhone

Checked against current official documentation on **2026-09-03**.

| Source | What it supports |
|---|---|
| [Webhooks](https://docs.agentphone.ai/documentation/guides/webhooks) | Per-agent override behavior, current message envelope, raw-body HMAC, five-minute timestamp window, `X-Webhook-ID` deduplication, six-attempt retry schedule, secret rotation |
| [Messages](https://docs.agentphone.ai/documentation/guides/messages) | `POST /v1/messages`, `agent_id`/`to_number`/`body`, response receipt and channel fields |
| [Error handling](https://docs.agentphone.ai/documentation/reference/error-handling) | Error shapes, retryable vs persistent `429` codes, absence of idempotency keys, ambiguous `5xx` warning |
| [Messaging rate limits](https://docs.agentphone.ai/documentation/reference/messaging-rate-limits) | 10DLC dependency, throughput, compliant first-message copy, and distinction between API acceptance and device delivery |
| [Phone numbers](https://docs.agentphone.ai/documentation/guides/phone-numbers) | Separate number creation/attachment, inbound availability, outbound 10DLC requirement, and irreversible release warning |
| [Usage and billing](https://docs.agentphone.ai/usage) | Current pay-as-you-go prices and provisioning limits; no paid resource was created in this task |

## Evidence language used in this project

- **Confirmed:** directly present in a current primary source or observed locally.
- **User-confirmed:** stated by the account owner but not independently authenticated in this session.
- **Locally verified:** executed or checked on this Windows host in this session.
- **Documented:** listed by an official source but not executed locally.
- **Untested:** plausible or documented elsewhere, but no current local receipt.
- **Mocked:** deterministic fake data with no DoorDash or payment side effect.
