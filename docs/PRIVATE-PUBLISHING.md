# Private publishing pilot

Status: implementation branch, **not deployed**. Commons Host authentication,
the private project screen, isolated browser delivery, and testnet payment through
the Commons proxy are implemented. Renewal, human wallet setup, and deployment
remain in progress. Keep `OPENQUICK_PRIVATE_PUBLISHING` unset in production until
the rollout gates pass.

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
credentials cannot operate this pilot. Commons humans use short-lived publishing
tickets instead; the application never receives their Commons login credential.

| Method and route | Purpose |
| --- | --- |
| `POST /api/v1/private-projects` | `{name, files, viewers}` plus stable `Idempotency-Key`; returns an unpaid intent |
| `GET /api/v1/private-projects` | Active projects the authenticated identity can view |
| `GET /api/v1/private-projects/:slug` | Authorized project metadata and dedicated browser origin |
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

## Commons browser flow and isolation

Hosts use Commons' `/s/open-quick/settings/payments/publishing` screen to upload
files, review a purchase, pay, open a project, and update files or viewers. It is
hidden from anonymous users and ordinary members. Each operation obtains a signed
ticket from Commons, bound to its active human session, current Owner/Host role,
the OpenQuick audience, and a five-minute expiry. OpenQuick verifies the ticket
against the configured Commons origin on every request. Role loss, sign-out,
suspension, Space archiving, or disabling the beta invalidates existing tickets.

Management tickets and project-specific read tickets have different purposes;
read tickets cannot create projects or pay. The latter are POSTed to a project's
dedicated hostname and become a Secure, HttpOnly, host-only cookie. Cookies and
login tokens never appear in URLs. The form preserves the Commons Origin header
and uses `noopener`. A `noreferrer` cross-origin form with `_blank` produces an
opaque Origin in Chromium and is deliberately rejected by the receiving route.

**Each browser project has its own hostname.** Multiple private projects cannot
safely share an origin with arbitrary JavaScript. The operator preallocates 1–16
hostnames on the same Railway service and volume. A hostname is reserved durably
before charging and is never reused for another project. Capacity is rejected
before payment. Adding capacity means adding another hostname to the configured
pool, not another service, database, or volume.

These hostnames expose only the read-session exchange and authenticated private
assets. Public sites, the console, and payment APIs are absent. Hostname, project,
viewer access, active session, and hosting expiry are checked before every read.
CORP and COOP require the same origin; the response CSP restricts resources and
connections to this project, disables workers, forms, frames and popups, and
preserves script/module operation. Ordinary static modules and local JSON fetches
work. Private responses are never publicly cached. Previously authorized users
can retain content they already downloaded; this is access control, not DRM.

The pre-existing public Pro release checkout/status/pay endpoints now require an
allowlisted owner credential too. Anonymous discovery omits their OpenAPI entries.
Commons now links to private publishing. The old public Pro browser checkout is
retired from that UI; approved API clients can still access their existing Pro
orders. Existing public releases and settled records remain intact.

### Configuration

Commons API/web: existing payment beta and Space allowlist settings plus
`OPENQUICK_PRIVATE_PUBLISHING=true`. The web needs `OPENQUICK_URL` (public API
origin) and `OPENQUICK_PRIVATE_ORIGINS` (comma-separated dedicated HTTPS origins).
The API derives a purpose-specific ticket signature from the existing persistent
MPP secret; no human session credential is shared with OpenQuick.

OpenQuick: `OPENQUICK_PRIVATE_PUBLISHING=true`, existing persistent Pro secret,
testnet recipient and approved agent list, `OPENQUICK_COMMONS_ORIGIN`, and the
same `OPENQUICK_PRIVATE_ORIGINS` pool. Every private hostname must differ from the
Commons and public-content hostname. TLS may terminate at Railway; routing uses
the configured hostname, never a caller's forwarded-proto value. Do not remove or
reassign a hostname belonging to a paid project.

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

- Typecheck and build passed; full suite passed 92 tests at the latest checkpoint.
- Actual local HTTP + testnet payment passed:
  `0xb0c47da64d87c5b5cc033679b1a76aecc66b1722ac7136fabb503db187debcbd`.
- Receiver increased by exactly 10000 atomic pathUSD. Anonymous page/asset reads
  and public fallback routes returned 404. Update and retry added no charge.
- This is **not** production deployment evidence or a human wallet/browser test.

The later combined Commons browser rehearsal passed with transaction
`0x4d3608aa90e2ab043dbeb7fd9ebb6ab0ac347effb09dfd6480e4066a012d7915`.
Its disposable Commons receiver `0x549d5ca66859a99d17177e45b906491043f06e74`
gained exactly 10000 atomic pathUSD. The private tab opened, the Space balance
displayed the receipt's funds, anonymous/ordinary-member access was denied, and
removing the Host role invalidated the browser cookie. Retrying did not pay again.
This uses an automated in-memory payer, not a human passkey or live funds.

Chromium tests exercise two separate private origins, real Secure cookies over
HTTPS, static modules/local data, cross-project reads and script inclusion, public
page attacks, viewer revocation, role loss, cookie scope, capacity before payment,
and attempted use of a read ticket as management authority.

The Commons checkout includes `scripts/private-publishing-e2e.mjs`. With both
repositories built, run it with `OPENQUICK_E2E_CHECKOUT` pointing at this checkout.
It creates a disposable in-memory Commons server and test receiving wallet,
launches an isolated copy of the web UI, creates a purchase in a browser, pays
through Commons with real testnet tokens, opens the private tab, and verifies
the Space's on-chain balance and access gates. It does not exercise an actual
human passkey or external wallet approval.

Remaining: durable immutable price/network/term fields before configurable live
pricing, renewals, human production-wallet proof/setup, withdrawal rehearsal,
reviewed PRs, production deployment, and a production-hosted testnet payment.
