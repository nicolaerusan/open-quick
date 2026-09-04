# Opt-in Pro deploy pilot

The first paid product is a new immutable static release, priced by OpenQuick at
0.01 pathUSD on Tempo testnet. It is a separate opt-in action; ordinary publishing
keeps its existing flow. This is production-hosted testing, not a live-dollar sale.
No Commons service registration is required. Commons supplies the receiving address
and displays its current token balance, including these direct MPP payments.

An authenticated, allowlisted, unscoped agent calls POST /api/v1/pro-deploys with a
stable Idempotency-Key and base64 files. This validates content, fixes its hash,
reserves a random Pro slug, and returns checkoutUrl and paymentUrl. The human can
pay through a compatible injected Tempo wallet on the checkout page, or an MPP
agent can pay the same paymentUrl. OpenQuick verifies a route-bound challenge and
confirmed transfer before publishing. The receipt links the transaction and release.
The browser checks the exact amount/token/network and expected recipient before
requesting a signature. A compatible wallet and testnet funding are prerequisites;
card checkout is not available.

The pilot is limited to 50 files, 1 MB decoded, 20 intents/hour/actor, and 1000 total
intents pending operator cleanup. It uses the existing single process and mounted
volume. Orders are fsynced, then renamed atomically. Status moves pending →
processing → paid → published. A process interrupted during settlement leaves
processing and refuses another payment until operator reconciliation. Paid orders
can resume publication without charging again. Once published, uploaded staging
content is removed from the order and retries return the same release. Pro slugs
cannot be modified through the ordinary deploy/rollback routes. Prices are fixed
for this pilot; configuration changes require draining pending intents first.

Configuration, via Railway secret variables:

- OPENQUICK_PRO_PAYMENTS=true
- OPENQUICK_PRO_RECIPIENT: the OpenQuick Space's Tempo testnet destination
- OPENQUICK_PRO_SECRET: independent random 32-byte hex secret; keep persistent
- OPENQUICK_PRO_ACTORS: comma-separated approved handles; default operator

Receiving requires no wallet private key. The secret signs payment challenges;
it cannot withdraw funds. The Space account's human wallet or deployment owner
retains custody. Live money requires a verified human-controlled mainnet receiving
wallet, an ownership/withdrawal rehearsal, and a separately configured network and
token. Do not fund this testnet address with live funds.

Reconciliation: inspect the private pro-orders record and Tempo transaction. Never
change an uncertain order back to pending. If a transaction confirmed with the exact
memo, token, destination and amount for this order, reconcile it to paid with the
verified reference/receipt; if no broadcast occurred, document that determination
before deciding how to retire the intent. Do not guess based on balance changes.
Back up the mounted volume. This does not implement refunds, taxes, a revenue
ledger in Commons, or outgoing agent spending.

Deployment source: this branch starts from accepted Space-main ce92500ae6728b8efd083d1f7b051b9fb8b95e9e,
preserving the newer credential and publishing fixes absent from the old GitHub
production branch. Production must attest the exact deployed Git revision and pass
the existing promotion contract gate. Roll back to the recorded previous Railway
deployment if its health or existing publishing contract fails; retain the volume
and payment configuration for reconciliation.
