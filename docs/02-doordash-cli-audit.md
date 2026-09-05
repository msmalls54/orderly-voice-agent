# DoorDash CLI capability and local-access audit

Audit date: 2026-09-03, America/Los_Angeles.

## Bottom line

DoorDash officially documents the consumer ordering capabilities needed for Orderly, including search, menus, carts, price preview, saved cards, tips, order submission, status, history, receipts, pickup/delivery, scheduling, promos, and credits. The latest public release is **v0.2.4**.

This Windows host cannot execute it today: DoorDash distributes macOS ARM64 and Linux AMD64 binaries, and this machine has no WSL or Docker. The user confirms receiving beta access by email, but authentication and account-specific commands were not locally tested. No paid action was attempted.

## Officially documented capability matrix

| Capability | Official status | Local status | Orderly posture |
|---|---|---|---|
| Installation/version | v0.2.4 for macOS ARM64 and Linux AMD64 | Archive checksum verified; binary not executed | Pin exact version and checksum |
| Command discovery | `dd-cli --help` and nested `--help` | Blocked by host OS | Run on supported host before implementation |
| Login | Browser-based `dd-cli login` | Not tested | Human completes login; agent never sees password |
| Headless auth | `DD_CLI_ACCESS_TOKEN` from `dd-cli export-token` | Not tested | Inject only into CLI child process/secret store |
| Store search | Free-form search, nearby stores, store details | Not tested | Read-only, at most three spoken choices |
| Menu/item search | Browse menus, search items, item details | Not tested | Sanitize merchant text as data |
| Saved addresses | List/set; v0.2.3 added find/add | Not tested | Agent may select only pre-approved saved reference; no raw address in model logs |
| Payment methods | List saved methods, currently card-only | Not tested | Speak only brand/last four if returned; never allow changes |
| Order history/reorder | History, recreate a past order, group-order history | Not tested | Needed for “last Tuesday”; minimize retention |
| Cart | List, add/remove, show, delete; individual/group | Not tested | Refuse unexpected existing carts |
| Promotions | Eligible campaigns, promo apply/remove; v0.2.4 surfaces item eligibility | Not tested | Do not auto-change after confirmation |
| Credits/work benefits | Apply credits; work budgets documented | Not tested | Any use changes checkout hash and requires reconfirmation |
| Tip | Set during preview/submit | Not tested | Explicit value required before confirmation |
| Final price/fees | Order preview | Not tested | Preview is the sole source of total |
| Submit | Order submit or browser checkout fallback | Not tested and disabled | Internal-only, absent from buildathon path |
| Payment/order status | Payment status and full lifecycle status | Not tested | Reconcile after ambiguous submit; never blind retry |
| Receipts | Fetch receipts | Not tested | Do not persist raw receipt in Orderly |
| Fulfillment | Delivery and pickup | Not tested | MVP supports delivery only |
| Scheduling | ASAP and schedule-ahead | Not tested | MVP supports ASAP only |
| Delivery speed | Standard and priority/express | Not tested | MVP supports standard only |
| Structured output | `--json-output` is used by the documented agent ecosystem and official-repo issue examples | Not tested | Require JSON; reject unexpected shapes |
| Intent metadata | v0.2.2 requires `--intent` on tool-backed commands | Not tested | Generate a bounded, non-PII purpose string |

Official capability source: [DoorDash CLI README](https://github.com/doordash-oss/doordash-cli). Version changes: [v0.2.4](https://github.com/doordash-oss/doordash-cli/releases/tag/v0.2.4) and [releases index](https://github.com/doordash-oss/doordash-cli/releases).

## Authentication and credential behavior

- `dd-cli login` opens a browser. The human should authenticate directly; automation must not request or capture the password.
- Starting in v0.2.3, macOS stores a refresh token in Keychain and renews access automatically.
- Headless Linux uses `DD_CLI_ACCESS_TOKEN`. Official release notes say refresh tokens are not stored in headless/cloud contexts.
- `dd-cli export-token` must run on a machine where the user has signed in.
- Exact access-token lifetime and a supported automated refresh path are not publicly documented. Treat token expiry as expected and fail closed.
- Never put the token in a prompt, CLI argument, repository, screenshot, general process environment, or log. Pass it only in the child process environment or a platform secret binding.

## Local verification receipt

| Check | Result |
|---|---|
| Operating system | Windows 10 build 26200, x64 |
| Native `dd-cli` on PATH | Not found |
| WSL | Not installed |
| Docker | Not installed |
| Matching archive in Downloads or local bin | Not found |
| DoorDash environment-variable names visible | None found |
| User beta access | User-confirmed; no local auth receipt |
| Latest GitHub release | v0.2.4, published September 3, 2026 |
| Linux archive integrity | Passed: published hash equals computed hash |
| Root/nested command help | Not executable on this host |
| Account search/menu/history/cart | Untested |
| Order submission | Not attempted; prohibited by project safety policy |

The Linux v0.2.4 quickstart incorrectly calls its included Linux binary “macOS Apple Silicon.” Treat that line as a packaging-documentation defect; the asset name, README, and release notes identify Linux AMD64 support.

## Terms and data-handling constraints

The official release includes `LICENSE.txt`, last updated June 30, 2026. It makes the account owner responsible for agent actions, limits the CLI to the user’s own account, forbids credential sharing, restricts retention/porting of CLI-accessed data, and warns that DoorDash may not add its own human confirmation before an agent order completes.

The user has explicitly confirmed that this is an authorized, own-account hackathon beta test. Orderly therefore keeps the CLI lane single-user and non-production, sends no paid order, and stores no raw DoorDash data. Any public or multi-user launch would require a separate DoorDash-approved integration and written data-handling terms.

## Supported-host verification sequence

Run this only on the user’s supported macOS ARM64 machine or a trusted Linux AMD64 environment:

1. Download v0.2.4 from the official release and compare SHA-256.
2. Run `dd-cli --help`, save only command names and version—not account data.
3. Human runs `dd-cli login` in the local browser.
4. Run address and payment-method list commands only long enough to confirm they work; do not capture output in notes.
5. Run one store search and one menu lookup with JSON output.
6. Run order history with the smallest limit; do not persist the response.
7. Create no cart until unexpected-cart behavior is understood.
8. If testing a cart, use a non-age-restricted item, preview, then delete the cart. Do not submit.
9. Record capability pass/fail and redacted response shape only.
10. Keep `PURCHASE_ENABLED=false`.

## Unresolved CLI questions

- Exact v0.2.4 root and nested command inventory.
- Exact JSON schemas and stable error codes.
- Token lifetime and refresh behavior on Linux.
- Whether browser checkout fallback can name wallet payment methods.
- Whether order preview always includes tax, every fee, tip, credits, promo, fulfillment mode, and schedule in one response.
- Whether cart/submit supports a caller-provided idempotency key. Assume it does not until proven otherwise.
- Whether a preview or submit can race with DoorDash price/availability changes and how that change is signaled.

