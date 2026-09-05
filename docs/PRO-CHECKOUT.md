# OpenQuick Pro checkout

The first Pro offer is one private static project hosted for 30 days, including
updates during that term. It is a one-time purchase with no automatic renewal.
The beta price is 0.01 pathUSD on Tempo testnet or, after a separate rollout,
0.01 USDC.e on Tempo mainnet. This is a pilot price, not a finalized commercial
subscription price. Private files remain limited to 50 files and 1 MB.

## Human checkout

1. Open the OpenQuick app and choose **Pro** in the main navigation. The Pro
   offer is visible before sign-in; purchases remain restricted to the Host beta.
2. **Continue with Commons** uses the existing Commons account to identify the
   Host, then immediately returns to OpenQuick. It does not visit Space settings.
   OpenQuick binds the callback to a random, short-lived, host-only sign-in cookie.
   Commons posts its purpose-specific ticket to the fixed OpenQuick callback; no
   session credential appears in the URL or reaches public hosted content.
3. Upload files or a folder, or use the sample wiki. Review the fixed quote.
   Creating a quote reserves a project hostname but does not charge anything.
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

Card checkout, card payouts, additional crypto methods, automated spending and
automatic renewal are not implemented by this change.
