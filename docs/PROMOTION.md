# OpenQuick promotion contract (Space-main to Railway)

## Source of truth

Production application code is pinned to an exact commit on the Commons
**Space-main** branch of this repository. Railway deployments must be
traceable to that commit via build-time identity env vars (below). Do not
treat agent transcripts, temporary branches, or the platform default git SHA
injection as the promotion pin.

## Authorized actor

Only an **operator with Railway project access** may promote or roll back
production. Agent transcripts and Commons task results document the handoff;
they never hold Railway or OpenQuick credentials and must not request them.

Task **#90** remains a hosted **content probe** only. It must not gain
application-deploy authority.

## Gate command

Fail-closed executable gate lives at `scripts/promotion-contract-gate.mjs`.
Package script name: `gate:promotion`.

    node scripts/promotion-contract-gate.mjs --pin <40-char-lowercase-sha> --host https://<origin>

Modes:

    --build-only
    --live-only --host https://<origin>
    --require-attestation --require-public-read --require-release-url

Exit codes: `0` ok, `1` failure, `2` usage. Soft notes (public-read gaps,
attestation 404, missing releaseUrl) do not fail unless the matching
`--require-*` flag is set. Deploy OpenAPI `$ref` checks for responses
`201`/`401`/`413`/`422` always fail closed.

Related helper: `scripts/assert-production-revision.mjs`.

## Operator handoff — pin `70becb59a9a8bdf50ff895aec3c410b11592359b`

1. On a clean checkout of Space-main at
   `70becb59a9a8bdf50ff895aec3c410b11592359b`, run the gate with
   `--pin 70becb59a9a8bdf50ff895aec3c410b11592359b --build-only`.
2. In Railway (operator credentials only; never paste into Commons), deploy
   that exact commit and set at **build** (Docker build args / service env):
   - `OPENQUICK_SOURCE_REVISION=70becb59a9a8bdf50ff895aec3c410b11592359b`
   - `OPENQUICK_BUILT_AT=<RFC3339 UTC timestamp>`
   - `OPENQUICK_DEPLOYMENT_ID=<opaque Railway deployment id>`
   Do **not** fall back to the platform-injected git commit SHA env var.
3. After deploy, re-run the gate with
   `--live-only --pin 70becb59a9a8bdf50ff895aec3c410b11592359b`
   `--host https://open-quick-production.up.railway.app --require-attestation`.
4. Record the Railway deployment id, checked timestamp, health, and live
   OpenAPI evidence back on Commons result task #99 / umbrella #80. Do not
   publish credentials.

## Rollback

Redeploy the previously known-good Space-main pin with the same identity env
vars for that pin, then re-run the gate (`--live-only` with
`--require-attestation` once attestation is live). Trigger: failed gate,
bad health, or operator judgment. Task #90 continues as content-probe signal
only.
