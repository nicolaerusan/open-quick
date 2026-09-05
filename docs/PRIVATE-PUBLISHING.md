# Private publishing pilot

Status: implementation branch, **not deployed**. The authenticated HTTP API and
real Tempo testnet settlement have been exercised. Human browser onboarding,
isolated browser delivery, renewal, and mainnet wallet setup remain in progress.
Keep `OPENQUICK_PRIVATE_PUBLISHING` unset in production until those gates pass.

## Product and current API

A new purchase creates private hosting for 30 days from the first stored release,
at 0.01 pathUSD on Tempo **testnet**. That price exercises the protocol; it is not
a proposed commercial price. Each release is limited to 50 files / 1 MB, including
`index.html`. Up to 100 releases are retained per project in this pilot.

Files and payment orders live under a separate `private-hosting` volume directory.
Private slugs cannot be deployed through the public API, do not appear on the
homepage or public inventory, and cannot be fetched via public release paths.
The owner can deploy updates during the paid term and change the viewer list.
Every asset and history request checks the current ACL and expiry before reading
bytes. Responses use `private, no-store`; conditionals do not bypass access checks.

API calls use `X-OpenQuick-Authorization: Bearer <deploy credential>` so an MPP
`Authorization: Payment …` header can coexist with application authentication.
Regular Bearer authorization also works when no payment credential is present.
Never put either credential in a URL, public resource, or command-line argument.
Identities must appear in the operator's explicit pilot allowlist; scoped deploy
credentials cannot operate this pilot. This is not yet a Commons human-role bridge.

| Method and route | Purpose |
| --- | --- |
| `POST /api/v1/private-projects` | `{name, files, viewers}` plus stable `Idempotency-Key`; returns an unpaid intent |
| `GET /api/v1/private-projects` | Active projects the authenticated identity can view |
| `GET /api/v1/private-payments/:id` | Owner-only immutable purchase and receipt |
| `GET /api/v1/private-payments/:id/pay` | Owner-only MPP challenge, settlement, and private delivery |
| `POST /api/v1/private-projects/:slug/deploy` | Owner-only `{files}` update within the term |
| `POST /api/v1/private-projects/:slug/viewers` | Owner-only `{viewers}` replacement, applied immediately |
| `GET /api/v1/private-projects/:slug/releases` | Authorized release history |
| `GET /private/:slug/*` | Authorized active assets or `releases/:releaseId/*` |

The create idempotency key binds the initial content, project name, and initial
audience. Changing the audience later does not invalidate purchase retries.
Confirmed payments survive restart, and retrying the order neither charges again
nor extends the original term. Ambiguous settlement fails closed for reconciliation.
Do not create a new purchase key to retry an uncertain payment.

## Browser boundary still to complete

The current API requires explicit bearer headers; it does not introduce browser
cookies on OpenQuick's public-content origin. A returned private URL alone will
therefore fail in an ordinary browser. The existing `checkoutUrl` is not a working
private-project human checkout yet. This must be resolved before rollout.

The next implementation must connect Commons' current human Owner/Host authority
to the pilot, protect checkout as well as assets, and deliver private browser
content on an isolated origin. Do not add ambient console cookies to the existing
public hosted-content origin. CSP sandbox headers currently restrict API-fetched
artifacts but do not constitute verified full browser isolation.

The pre-existing public Pro release checkout/status/pay endpoints now require an
allowlisted owner credential too. Anonymous discovery omits their OpenAPI entries.
The host-facing browser bridge must support these routes before this branch ships.
Existing public releases and settled records remain intact.

## Reproduce actual testnet settlement

```sh
npm ci
npm run typecheck
npm test
npm run build
node scripts/private-payments-smoke.mjs
```

The smoke starts an ephemeral loopback HTTP server and generates a disposable
payer in memory. It obtains free faucet funds, pays the real Tempo testnet, reads
the on-chain transaction receipt, and checks the receiver's exact balance delta.
It then verifies protected HTML and an asset, absent public inventory, included
updates, and a retry with no second charge. Temporary local content is removed
on exit. Neither payer keys nor application credentials are logged or persisted.

For a deployed pilot, supply these through a private process environment:

- `OPENQUICK_PRIVATE_SMOKE_URL`: HTTPS origin
- `OPENQUICK_PRIVATE_SMOKE_TOKEN`: approved deploy credential
- `OPENQUICK_PRIVATE_SMOKE_RECIPIENT`: independently verified expected testnet address

The script validates test mode, chain 42431, token, amount, recipient, and payment
origin before paying. It cannot spend live funds. Remote runs retain one small
private test project and receipt for inspection.

## Evidence, 2026-09-05 UTC

- Typecheck and build passed; full suite passed 90 tests at the latest checkpoint.
- Actual local HTTP + testnet payment passed:
  `0xb0c47da64d87c5b5cc033679b1a76aecc66b1722ac7136fabb503db187debcbd`.
- Receiver increased by exactly 10000 atomic pathUSD. Anonymous page/asset reads
  and public fallback routes returned 404. Update and retry added no charge.
- This is **not** production deployment evidence or a human wallet/browser test.

Remaining: host identity bridge and UI, browser isolation tests, renewals, production
wallet proof/setup, withdrawal walkthrough, final regression checks, reviewed PRs,
production deployment, and a production-hosted testnet payment/access test.
