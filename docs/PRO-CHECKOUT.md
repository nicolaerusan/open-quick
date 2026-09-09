# OpenQuick Pro checkout

The first Pro offer is one private static project hosted for 30 days, including
updates during that term. It is a one-time purchase with no automatic renewal.
The card offer is **$5.00 USD for one private site for 30 days**. It is a
separate payment choice from the existing Tempo wallet offer; additional sites
require additional purchases.
The beta price is 0.01 pathUSD on Tempo testnet or, after a separate rollout,
0.01 USDC.e on Tempo mainnet. This is a pilot price, not a finalized commercial
subscription price. Private files remain limited to 50 files and 1 MB.

## Human checkout

1. Open the OpenQuick app and choose **Pro** in the main navigation. The Pro
   offer is visible before sign-in; purchases remain restricted to the Host beta.
2. **Sign in with Commons to purchase Pro** uses the existing Commons account to identify the
   Host, then immediately returns to OpenQuick. It does not visit Space settings.
   OpenQuick binds the callback to a random, short-lived, host-only sign-in cookie.
   Commons posts its purpose-specific ticket to the fixed OpenQuick callback; no
   session credential appears in the URL or reaches public hosted content.
3. Upload files or a folder, or use the sample wiki. Review the fixed quote.
   Creating a quote reserves a project hostname but does not charge anything.
   On return, continue under **Your Pro purchases**. An expired payment window
   shows **Resume purchase**; this keeps the saved files, price and hostname.
4. **Choose payment wallet** opens the official Tempo Wallet popup without an
   agent access key. Review the amount, asset, network and receiver before approval.
5. The browser validates the MPP challenge and requests a sign-only pull credential.
   OpenQuick records the attempt before broadcast, confirms settlement and publishes.
   Reusing a paid purchase finishes delivery without a second payment.
6. **Your private projects** in OpenQuick provides **Open private project**, included
   updates and viewer management. If sign-in expires, use **Sign in again** in
   OpenQuick and reuse the saved purchase. Commons keeps the receiving wallet and
   balance. Its former publishing page now links to the OpenQuick app.

Private-page opening uses a separate opaque viewing grant, bound to the project
and a live Commons identity. The general API ticket stays in a bounded in-memory
OpenQuick map and never enters the uploaded page's origin. Each asset request
rechecks the underlying identity, project access and hosting expiry. A process
restart clears these short-lived grants; reopen the project from OpenQuick.
Purchases, project files, payment receipts and hosting terms remain durable.

The form-bearing sign-in and checkout pages use an origin-only referrer policy
so browser form POSTs retain their verifiable Origin without disclosing paths,
query state or tickets. Callback Origin and pending sign-in state are both checked;
private APIs keep same-origin mutation checks and private caching headers.

The receiving human withdraws independently from the wallet that controls the
quoted destination. This checkout grants the buyer a hosting entitlement; it
does not grant agents spending authority over the Space's wallet.

## Deployment and isolation

Keep one OpenQuick process and mounted volume. Add a hostname on that same
service for `OPENQUICK_PRO_CHECKOUT_ORIGIN`. It must differ by hostname from the
public service, Commons, and every private-content origin. A different port is
insufficient. The checkout origin serves only the checkout and authenticated
private-project APIs; it never serves uploaded content, the public console, or
public discovery. All other paths return 404.

Checkout uses an HttpOnly, Secure, host-only cookie. Every request revalidates
the underlying Commons session and live Host role. Cookie-authenticated writes
also require the checkout's exact Origin. Public-hosted JavaScript cannot read
the checkout or its private-project data. The public app links into this isolated OpenQuick checkout. The legacy header-authenticated agent
API stays on the public API origin and does not accept this browser cookie there.

Roll out in this order:

1. Deploy OpenQuick with `OPENQUICK_PRIVATE_MAINNET_PAYMENTS=false` and the
   isolated `OPENQUICK_PRO_CHECKOUT_ORIGIN`. Retain `OPENQUICK_PRO_RECIPIENT` as
   the original testnet receiver and preserve the challenge secret and volume.
2. Deploy the compatible Commons browser client, setting the same checkout
   origin. Verify anonymous denial, Host ticket exchange, isolated checkout,
   existing receipts, and testnet settlement/retry behavior.
3. Independently read the human-verified mainnet receiver from the Space. Set
   `OPENQUICK_MAINNET_RECIPIENT` to that public address; no wallet key is needed.
4. Enable `OPENQUICK_PRIVATE_MAINNET_PAYMENTS=true` only for the approved pilot.
   New private orders use Tempo chain 4217 and USDC.e contract
   `0x20c000000000000000000000b9537d11c60e8b50`. Old test orders retain chain
   42431, pathUSD, and their original recipient and term.
5. A human separately funds/authorizes a small buyer payment. Confirm its chain
   receipt, hosted content and receiver balance. Never assume a successful
   automated test constituted a human's mainnet spending approval.

To pause new mainnet charging, set `OPENQUICK_PRIVATE_MAINNET_PAYMENTS=false`.
Pending mainnet payments are rejected before verification/broadcast. Published
receipts and paid-but-unfinished delivery remain available, and new quotes use
testnet. Keep the isolated checkout origin configured. Before rolling back to
code that does not understand mainnet quotes, disable the private payment entry
points; do not reinterpret mainnet orders as legacy test orders. Preserve all
order files, the volume, secrets, and receiving-address configuration.

## Agent buyer

An approved OpenQuick agent creates `/api/v1/private-projects` with a stable
Idempotency-Key, project name, base64 files and approved viewers. It reads the
returned quote and pays `/api/v1/private-payments/:id/pay` using MPP, keeping its
application credential in `X-OpenQuick-Authorization` and payment proof separate.
An address alone is not spending authority. A human can approve each transaction
or authorize a dedicated buyer wallet/access key with a limited budget and
expiry. Never paste private keys, passkey recovery material or CLI state in chat.

Commons **Agent access** allows receiving-account lookup and test deposit
requests. It does not authorize the buyer, unlock OpenQuick's application API,
or allow spending. The wallet balance includes direct OpenQuick receipts, but
Commons' request ledger is not yet a unified OpenQuick sales ledger.

## Cards and other payment methods

Use one product and hosting entitlement with separate, explicit payment offers.
The preferred card flow is Stripe-hosted Checkout backed by a human-managed
connected account for the Space. Where appropriate, a direct charge places the
sale in that connected account, and the account holder manages bank payout
details. See [Stripe direct charges](https://docs.stripe.com/connect/direct-charges)
and [connected-account payouts](https://docs.stripe.com/connect/payouts-connected-accounts).

MPP is payment-method agnostic: it can advertise Stripe and other methods in
addition to Tempo. [MPP's multiple-method guidance](https://mpp.dev/blog/multi-method-discovery)
describes that surface. A regular human card checkout can coexist with the MPP
Stripe adapter for compatible agent buyers. Supporting another method does not
require a separate Pro product or a service-price registration in Commons.

Before shipping cards:

- Have the human complete Stripe onboarding and payout details. Choose a
  commercially suitable card price; do not copy the 0.01 on-chain pilot amount
  into a card checkout by assumption.
- Persist each offer's amount, currency, method, account and provider reference.
  USD cents and six-decimal USDC.e are distinct accounting units.
- Lock an order to an in-flight payment attempt before starting another method.
  A delayed card success must not race a second MPP payment for the same order.
- Validate webhook signatures and exact connected account, amount, currency and
  order metadata. Deduplicate provider events durably and grant hosting once.
  An unpaid redirect or pending bank payment does not unlock hosting.
- Record gross revenue, provider fees, refunds, disputes, payouts and withdrawals
  separately. Define refund/hosting-access policy and reconciliation before
  enabling live cards. A refunded charge does not erase the historical receipt.

### Stripe card rollout

The OpenQuick checkout has a Stripe-hosted card path when all of these server
variables are present: `OPENQUICK_STRIPE_ACCOUNT_ID`,
`OPENQUICK_STRIPE_PRICE_ID`, `OPENQUICK_STRIPE_MODE=live`,
`OPENQUICK_STRIPE_SECRET_KEY`, `OPENQUICK_STRIPE_WEBHOOK_SECRET`, and
`OPENQUICK_STRIPE_SELLER`. The configured Stripe Price must be a live, one-time
USD price of exactly 500 cents. The process checks the account and Price at
startup, creates a Checkout Session with an idempotency key, and never sends a
Stripe secret to the browser.

Stripe redirects successful or cancelled sessions back to
`/pro/hosting?stripe_order={orderId}`. The browser asks OpenQuick to reconcile
the session, while Stripe sends signed events to
`POST /webhooks/stripe` on the isolated checkout origin. OpenQuick verifies the
event signature, account, mode, exact Price, amount, currency and order
metadata before publishing. An unpaid or mismatched session does not unlock
hosting. Refund and dispute events refresh the durable payment record after
publication so the operator can reconcile access and revenue.

For a filmed demonstration, use a test-mode Price and a test webhook secret on
a disposable local checkout, then record the browser showing: create project →
choose **Pay $5 by card** → Stripe Checkout → return to OpenQuick → private site
published → refresh with the same order showing no second charge. Keep a second
window on Stripe’s test Payments and Webhooks pages, and show the order ID and
the matching `openquick_order` metadata. Playwright can record the browser
automatically with `recordVideo.dir`; for a live $5 charge, switch the same
script to the live origin only after the seller has approved the charge and use
the real card checkout. Apple’s built-in screen recording can capture the
browser and dashboard together.

The repository test `test/stripe-payments.test.ts` runs the same state machine
without a network charge: it proves that an unpaid Checkout Session leaves the
site unpublished and that one verified paid session publishes it exactly once.
Run `npm run typecheck`, `npm test`, and `npm run build` before recording.


## Browser payment regression and agent rehearsal

The browser payment client explicitly binds its fetch transport to the global
browser object before passing it to MPP. Calling the native fetch function as
an unbound SDK object method previously failed with Illegal invocation before
requesting a payment challenge. A Chromium regression runs the actual payment
module with native fetch; a separate UI test checks purchase guidance, wallet
matching notices and visible failures.

The signed-out entry explicitly says Sign in with Commons to purchase Pro.
Checkout links to Tempo Wallet for balances, brings the saved purchase into
view after review, and identifies when the selected payer is also the receiver.
This notice does not prohibit the transfer or change payment terms.

For a disposable agent onboarding and testnet purchase rehearsal, build the app
and run `OPENQUICK_PRIVATE_SMOKE_AGENT=true node scripts/private-payments-smoke.mjs`.
This option refuses remote targets. It simulates human approval on a local
fixture, delivers the agent credential once into process memory, purchases with
faucet tokens, verifies private delivery and checks retries/updates do not charge
a second time. It does not onboard a production agent or grant wallet spending
permission; the service credential and testnet signer are separate.

## Returning to a saved purchase

Payment windows last one hour, independently of the five-minute beta sign-in.
An owner can call `POST /api/v1/private-payments/:id/resume` to refresh an expired,
unpaid window. It changes only the expiry; order ID, files, audience, recipient,
network, price, hosting term and reserved hostname stay the same. Repeating the
call during an open window is idempotent. It never sends a payment or extends an
already-paid hosting term. Paid purchases return their existing receipt.

Processing or uncertain payments cannot be resumed into a payable state. A
changed receiving account, paused mainnet charging or malformed expiry also
requires review. An expired MPP challenge remains invalid after resuming; request
a fresh challenge before asking the wallet to approve payment.

The browser reloads the owner's saved purchases before creating an order. If
name, file hash and normalized audience match an unpaid purchase, it resumes
that purchase instead. Agents should retain their stable create idempotency key
and saved order ID, then use the resume endpoint when needed.

This recovery works when the hostname pool is full, because it reuses the
existing reservation. Distinct new projects still need a free configured private
hostname. No order is deleted and no hostname is reassigned by this change.

The agent testnet rehearsal also expires and resumes its ephemeral local order
before settlement, then verifies resuming the published order preserves its
receipt and original hosting expiry.
