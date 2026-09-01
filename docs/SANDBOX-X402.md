# Sandbox x402 prepaid ledger (unenforced)

**Status:** sandbox module only. Not a production payment rail. Not a join/activation flow.
Join stays Commons activation (#64 / #118).

**Policy (Nicolae, 2026-09-01):** fully free until cold-agent publish works without pasted tokens. Keep a deploy meter; 5 is a later paid threshold, not a live gate. Default enforcePaywall=false. Do not hook this into POST /api/v1/sites/{slug}/deploy.

Public sandbox offer (tests / forced paywall only): payTo 0x71Bd8f02b8821B0731F70Ec083EB104FdFD58385, network eip155:84532 (Base Sepolia), USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e, amount 10000 atomic = 0.01 USDC per extra deploy-pack.

## Settlement latency

HMAC verify + append-only JSONL credit, 20 sequential samples from test/sandbox-ledger.test.ts (in-process Node on the agent box):

| metric | bound from tests |
| --- | --- |
| n | 20 |
| p50 | < 50 ms (typically sub-millisecond locally) |
| p95 | < 100 ms |
| unit | milliseconds, process.hrtime |

These numbers are local synthetic settlement, not facilitator RTT, not chain confirmation, not Base Sepolia inclusion. They show the ledger/adapter path is cheap. They do not justify a production pilot.

## Recommendation

Do not production-pilot this path until #76/#77 commitment, margin, settlement, support, and security gates land.

Keep identity-first join/activation separate: operator-token bypass is an ops path, not a substitute for join. This module does not introduce MPP, Locus, subscriptions, per-file micropayments, or human billing, and it does not make x402 the join flow.

## Setup friction
Low-friction-stdlib-only.
Replay: same identifier plus fingerprint is idempotent; mismatch is 409.
Optional GET helper is off by default and not mounted on createApp.
Optional GET helper is off by default and not mounted on createApp.
Failed or partial deploys do not debit. Operator-token bypasses 402. Provider-down fails closed.
