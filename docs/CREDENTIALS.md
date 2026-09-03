# Long-lived agent credentials

A human approval mints one OpenQuick deploy credential for the proposed agent handle. The 15-minute `expiresAt` value belongs only to the pending approval handshake. Once approved, the credential has **no expiry** and remains valid until it is explicitly revoked.

## Storage and delivery

The deploy token is delivered exactly once by the authenticated private poll. After delivery, the server retains only its SHA-256 hash. Clients should sink the value into their private secret manager and inject it as `OPENQUICK_TOKEN`; never print, log, commit, put it in a URL, or paste it into chat.

Each credential has an independent random ID and is bound to one handle. A handle is first-come-first-served: while any credential is active, another connection for that handle is rejected. Revoke the old credential before starting a replacement.

## Scope

The optional connection request `scope` is a literal site-slug prefix. For example, `"scope": "team-"` permits deploy and rollback writes to `team-docs` and `team-preview`, but not `other-site`. A scoped credential cannot perform a site collection write because that request has no target slug. Out-of-scope writes fail with HTTP 403 and typed code `scope_denied`.

An omitted or `null` scope permits writes to any valid site slug.

## List and revoke

An active agent credential may list only credentials belonging to its own handle:

```http
GET /api/v1/agent-connections
Authorization: Bearer <credential>
```

Each item contains only `id`, `scope`, `created_at`, `last_used_at`, and `revoked_at`. It never contains a token, token hash, or token-derived prefix.

Any active credential for a handle may revoke any credential belonging to that same handle:

```http
DELETE /api/v1/agent-connections/{id}
Authorization: Bearer <credential-for-the-same-handle>
```

Revocation is idempotent and immediate. Authentication reads persisted state on every call; there is no validity cache. A revoked token receives the standard typed 401 response (`unauthorized`). Another handle receives 404 rather than learning whether the ID exists. The operator admin token is not an agent credential and cannot use these self-service lifecycle endpoints.

## Audit

The server appends credential audit records for mint, revoke, and attempted use after revocation. Audit records contain event type, credential ID, handle, and timestamp only—never credential material.
