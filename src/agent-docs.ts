import { proPaths } from "./pro-api-description.js";
const version = "0.1.0";

export function llmsTxt(baseUrl: string): string {
  return `# OpenQuick

> Deploy a folder of static HTML, CSS, and JavaScript to a durable URL.

Status: private preview. Public discovery is open; deploy credentials are minted through browser-mediated agent connection.

## Start here
- [Agent entry point](${baseUrl}/agent.md): Read this first for the supported workflow and safety boundaries.
- [Join guide](${baseUrl}/join): Human-readable onboarding for agents and operators.
- [Agent skill](${baseUrl}/skill.md): Exact deploy workflow, constraints, and receipt contract.
- [Authentication](${baseUrl}/auth.md): Current credential model and safe handling rules.
- [OpenAPI](${baseUrl}/openapi.json): Machine-readable HTTP API.
- [Agent card](${baseUrl}/.well-known/agent.json): Machine-readable capability discovery.

## Public endpoints
- [Health](${baseUrl}/healthz)
- [Production revision](${baseUrl}/.well-known/openquick-release.json)
- [Sites API](${baseUrl}/api/v1/sites)
- [Live sites](${baseUrl}/#sites)

## Examples
- [Signal Room](${baseUrl}/sites/signal-room/): Interactive, zero-backend example.
- [Hello](${baseUrl}/sites/hello/): Minimal static example.

## Source
- [Repository](https://github.com/nicolaerusan/open-quick)
- [Example folders](https://github.com/nicolaerusan/open-quick/tree/main/examples)
`;
}

export function agentMarkdown(baseUrl: string): string {
  return `# Join OpenQuick as an agent

OpenQuick turns a local folder containing an \`index.html\` into a live static site.

## Service state

- Host: ${baseUrl}
- Status: private preview
- Public access: capability discovery, health, production revision attestation, typed site listing/detail/history reads, and hosted sites
- Write access: operator token or a browser-approved agent deploy credential
- Limits: static files only; maximum decoded release size is 25 MB
- Deploy behavior: one atomic release replaces the selected site slug; rollback reactivates a prior immutable release without copying bytes

## Site URLs

- Mutable current site: \`${baseUrl}/sites/{slug}/\` and nested assets under that prefix. Redeploys update this URL in place.
- Immutable release permalink: \`${baseUrl}/sites/{slug}/releases/{releaseId}/\` and nested assets under that prefix. This always serves the exact bytes of that release.
- Unknown, malformed, cross-site, or traversal release IDs return 404 and never fall back to the current release.
- Ordered release history (metadata only): \`GET ${baseUrl}/api/v1/sites/{slug}/releases\`

## Decide whether you can join

You can deploy only if your runtime can store \`OPENQUICK_TOKEN\` or \`OPENQUICK_TOKEN_FILE\` privately. Do not ask a human to paste a token into chat. Do not print, log, commit, or place a token in a URL. Send it only in an Authorization header to the exact ${baseUrl} origin and do not forward it across redirects.

If you do not have a private credential sink, stop after public discovery. The start API fails closed unless privateSink is true.

## Long-lived credential lifecycle

Approval requires the requester-provided six-digit code (the URL alone cannot approve) and creates a handle-bound credential with no expiry; the connection expiresAt applies only while approval is pending. An optional string scope in the start request is a literal site-slug prefix. Store the one-time private poll result as OPENQUICK_TOKEN or via OPENQUICK_TOKEN_FILE. Handles are first-come-first-served: revoke before reconnecting the same handle; an active credential may list its handle-only metadata with GET ${baseUrl}/api/v1/agent-connections and revoke any credential for the same handle with DELETE ${baseUrl}/api/v1/agent-connections/{id}. Revocation is immediate. Lists expose only id, scope, created_at, last_used_at, and revoked_at—never secret material. Scoped out-of-prefix writes return typed 403 scope_denied.


## First deploy

1. Read [the skill](${baseUrl}/skill.md) and [auth rules](${baseUrl}/auth.md).
2. Confirm [health](${baseUrl}/healthz) returns \`{"ok":true}\`.
3. Start a browser-mediated connection: POST ${baseUrl}/api/v1/agent-connections with a proposed handle and privateSink true. Store the JSON privately (mode 0600). Ask a human to open approvalUrl and enter the six-digit approvalCode shown in your private start response. Poll pollUrl with the clientSecret until status is approved, then write token to OPENQUICK_TOKEN or OPENQUICK_TOKEN_FILE. Replay, expiry, and missing privateSink fail closed. Never put the token in a URL or chat.
4. Obtain the CLI from the source repository:

   \`\`\`sh
   git clone https://github.com/nicolaerusan/open-quick.git
   cd open-quick
   npm ci
   npm run build
   \`\`\`

5. Create or select a folder containing \`index.html\`, then deploy it:

   \`\`\`sh
   export OPENQUICK_HOST=${baseUrl}
   # OPENQUICK_TOKEN or OPENQUICK_TOKEN_FILE must already be injected privately. Never echo it.
   node dist/cli.js deploy ./path/to/folder --site my-site
   \`\`\`

6. Verify both returned URLs with GET requests: the mutable \`url\` and the immutable \`releaseUrl\`. Report the site slug, public URL, release URL, release ID, file count, and verification timestamp to the operator.

## Good first test

Deploy a disposable slug, verify its HTML and one linked asset, redeploy a changed version to the same slug, and confirm the mutable URL now serves the new release while the first \`releaseUrl\` still serves the original bytes. Do not overwrite a slug you do not own.

## Production revision

Credential-free GET ${baseUrl}/.well-known/openquick-release.json returns the exact Space-main git SHA this process was built to serve (\`sourceRevision\`), plus \`builtAt\` and an opaque \`deploymentId\`. Cache-Control is no-store. Production fails closed unless those values were injected at authorized build/deploy (\`OPENQUICK_SOURCE_REVISION\`, \`OPENQUICK_BUILT_AT\`, \`OPENQUICK_DEPLOYMENT_ID\`). Do not trust request parameters, GitHub main, or hosted files for this pin.

## Machine-readable resources

- ${baseUrl}/llms.txt
- ${baseUrl}/skill.md
- ${baseUrl}/openapi.json
- ${baseUrl}/.well-known/agent.json
- ${baseUrl}/.well-known/openquick-release.json
`;
}

export function skillMarkdown(baseUrl: string): string {
  return `---
name: openquick
description: Deploy a folder of static HTML, CSS, and JavaScript to an OpenQuick URL. Use when asked to publish, preview, or share a small static site through OpenQuick.
---

# Deploy with OpenQuick

Service version: ${version}

## Preconditions

- The folder must contain \`index.html\`.
- The decoded release must be 25 MB or smaller.
- Site slugs use lowercase letters, numbers, and hyphens.
- \`OPENQUICK_HOST\` must be \`${baseUrl}\` for production.
- \`OPENQUICK_TOKEN\` or \`OPENQUICK_TOKEN_FILE\` must come from a private credential store. Never request or reveal it in chat.

## Workflow

1. Inspect the folder. Do not upload secrets, environment files, source maps containing secrets, private notes, or unrelated files.
2. If \`openquick.json\` exists, use its \`site\` value unless the operator specifies another slug.
3. Build the OpenQuick CLI from [the repository](https://github.com/nicolaerusan/open-quick) with \`npm ci && npm run build\`.
4. Run:

   \`\`\`sh
   OPENQUICK_HOST=${baseUrl} node dist/cli.js deploy ./folder --site my-site
   \`\`\`

   The runtime must inject \`OPENQUICK_TOKEN\` privately.
5. Treat a non-2xx response as failure. Do not blindly retry 401, 413, or 422 responses.
6. GET the returned mutable public URL and the immutable release URL and verify expected content.
7. Return a receipt containing: slug, mutable URL, immutable release URL, release ID, file count, public agent handle (\`deployedBy\`), verification timestamp, and observed result. Never include the token.

## Constraints

- OpenQuick hosts static assets; it does not run server-side code.
- A deploy replaces the current release at the mutable \`/sites/{slug}/\` URL. The immutable \`/sites/{slug}/releases/{releaseId}/\` permalink keeps serving that exact release. Confirm ownership before overwriting.
- \`GET /api/v1/sites/{slug}/releases\` returns the current URL/release, file/byte totals, and newest-first history without copying release bytes.
- Authenticated \`POST /api/v1/sites/{slug}/rollback\` with \`{ "releaseId" }\` atomically activates a prior immutable release. Unknown or malformed IDs fail closed. Repeating the same rollback is idempotent.
- Never send the bearer token to another host or through a redirect.
- Do not claim success until the public URL has been checked.

## API

Read ${baseUrl}/openapi.json for request and response schemas. Public discovery and reads (health, production revision attestation at \`/.well-known/openquick-release.json\`, site list, site detail, site history, site-detail 404) need no token and expose typed application/json response schemas; authenticated deploys and rollbacks use bearer authentication with typed DeployReceipt/ErrorEnvelope responses.
`;
}

export function authMarkdown(baseUrl: string): string {
  return `# OpenQuick authentication

OpenQuick is currently a private preview.

## Available now

Agents start POST ${baseUrl}/api/v1/agent-connections with a proposed public handle, privateSink true, and optional literal site-slug-prefix scope. After a human opens approvalUrl, the requester must provide the six-digit approvalCode shown in the start response; the first private poll returns the deploy token once. Store it as OPENQUICK_TOKEN. The credential has no expiry after approval and remains valid until revoked. Send it as Authorization Bearer only to ${baseUrl}. The operator admin token still works for site writes and is attributed as handle operator.

An active agent credential may GET ${baseUrl}/api/v1/agent-connections to list lifecycle metadata for its own handle and DELETE ${baseUrl}/api/v1/agent-connections/{id} to revoke a credential belonging to the same handle. Handles are first-come-first-served: a second active connection for the same handle is rejected; revoke before reconnecting.

## Safety rules

- Never ask for, paste, print, log, commit, or publish the token.
- Never put it in a URL, prompt, task, Resource, screenshot, or example file.
- Do not forward credentials across redirects.
- Stop after a 401 and ask the operator to repair the private connection.
- Use a disposable site slug for initial testing.

## Fail closed

- Missing privateSink true is rejected.
- Unauthenticated writes return 401 with code unauthorized and never redirect.
- Revoked credentials immediately return that same typed 401. Out-of-scope writes return typed 403 scope_denied.
- The pending approval expires, but an approved deploy credential does not.
- A second poll after delivery returns 409 replay with no token.
- Credential lists contain only id, scope, created_at, last_used_at, and revoked_at.
- Approval pages, URLs, logs, audit records, errors, and ordinary responses never include credential material.

See ${baseUrl}/agent.md for the exact first-deploy flow.
`;
}

export function agentCard(baseUrl: string): Record<string, unknown> {
  return {
    name: "OpenQuick",
    version,
    description: "Deploy a folder of static files to a durable public URL.",
    status: "private_preview",
    homepage: baseUrl,
    documentation: `${baseUrl}/agent.md`,
    skill: `${baseUrl}/skill.md`,
    authentication: `${baseUrl}/auth.md`,
    openapi: `${baseUrl}/openapi.json`,
    release: `${baseUrl}/.well-known/openquick-release.json`,
    capabilities: {
      public: ["health", "list_sites", "read_site", "read_site_history", "read_production_revision"],
      authenticated: ["deploy_static_site", "rollback_site"],
      connection: ["start_agent_connection", "human_approve", "private_poll"],
      planned: ["mcp"],
    },
  };
}

export function openApiDocument(baseUrl: string, includePro = false): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenQuick API",
      version,
      description: "Public discovery and authenticated atomic deploys for static sites.",
    },
    servers: [{ url: baseUrl }],
    paths: {
      ...(includePro ? proPaths : {}),
      "/healthz": {
        get: {
          operationId: "getHealth",
          summary: "Check service health",
          responses: {
            "200": {
              description: "Healthy",
              content: { "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } } },
            },
          },
        },
      },
      "/.well-known/openquick-release.json": {
        get: {
          operationId: "getOpenQuickRelease",
          summary: "Public production revision attestation",
          description: "Credential-free attestation of the exact Space-main revision this process was built to serve. Values are injected at authorized build/deploy. Cache-Control: no-store. Production processes refuse to listen without valid metadata.",
          responses: {
            "200": {
              description: "Pinned production revision",
              content: { "application/json": { schema: { $ref: "#/components/schemas/OpenQuickRelease" } } },
            },
            "404": {
              description: "Attestation not configured (non-production only)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SiteNotFoundError" } } },
            },
          },
        },
      },
      "/api/v1/sites": {
        get: {
          operationId: "listSites",
          summary: "List deployed sites",
          responses: {
            "200": {
              description: "Site list",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SiteListResponse" } } },
            },
          },
        },
        post: {
          operationId: "writeSitesCollection",
          summary: "Unauthenticated collection writes fail closed",
          description: "Console/collection writes require the existing agent-connection or operator bearer. Missing or invalid credentials return 401 and never redirect. Production returns documented 403 when a local auth bypass or insecure cookie mode is enabled.",
          security: [{ bearerAuth: [] }],
          responses: {
            "401": {
              description: "Missing or invalid token",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
            },
            "403": {
              description: "Production refuses writes while a local auth bypass or insecure cookie mode is enabled",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
            },
            "404": {
              description: "Authenticated collection POST has no create resource; use /api/v1/sites/{slug}/deploy",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SiteNotFoundError" } } },
            },
          },
        },
      },
      "/api/v1/sites/{slug}": {
        get: {
          operationId: "getSite",
          summary: "Get site metadata",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
          responses: {
            "200": {
              description: "Site metadata",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SiteDetailResponse" } } },
            },
            "404": {
              description: "Site not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SiteNotFoundError" } } },
            },
          },
        },
      },
      "/api/v1/agent-connections": {
        get: {
          operationId: "listAgentCredentials", summary: "List credentials belonging to the authenticated handle", security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Secret-free credential lifecycle metadata", content: { "application/json": { schema: { type: "object", required: ["handle", "credentials"], properties: { handle: { type: "string" }, credentials: { type: "array", items: { $ref: "#/components/schemas/AgentCredential" } } } } } } },
            "401": { description: "Missing, invalid, or revoked token", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          },
        },
        post: {
          operationId: "startAgentConnection", summary: "Start a browser-mediated agent connection",
          description: "Approval creates an independent handle-bound credential with no expiry. Optional scope is a literal site-slug prefix.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["handle", "privateSink"], properties: { handle: { type: "string" }, privateSink: { type: "boolean" }, scope: { anyOf: [{ type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,61}$" }, { type: "null" }] } } } } } },
          responses: { "201": { description: "Pending connection with approval URL and private poll secret" }, "400": { description: "Missing private sink, invalid handle, or invalid scope" } },
        },
      },
      "/api/v1/agent-connections/{id}": {
        delete: {
          operationId: "revokeAgentCredential", summary: "Immediately revoke a credential owned by the authenticated handle", security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[a-f0-9]{32}$" } }],
          responses: { "204": { description: "Credential revoked" }, "401": { description: "Missing, invalid, or revoked token", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } }, "404": { description: "Credential not found for this handle" } },
        },
      },
      "/api/v1/agent-connections/{id}/approve": {
        post: {
          operationId: "approveAgentConnection",
          summary: "Human approval of a pending connection",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Approved; deploy token is not returned here" }, "409": { description: "Replay" }, "410": { description: "Expired" } },
        },
      },
      "/api/v1/agent-connections/{id}/poll": {
        post: {
          operationId: "pollAgentConnection",
          summary: "Privately poll for a one-time deploy credential",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Pending or one-time approved token" }, "401": { description: "Bad client secret" }, "409": { description: "Already delivered" }, "410": { description: "Expired" } },
        },
      },
      "/sites/{slug}/": {
        get: {
          operationId: "getCurrentSite",
          summary: "Serve the mutable current release",
          description: "Mutable site URL. Nested assets live under this prefix. Redeploys update this URL in place.",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
          responses: {
            "200": { description: "Current-release asset" },
            "404": { description: "Site or asset not found" },
          },
        },
      },
      "/sites/{slug}/releases/{releaseId}/": {
        get: {
          operationId: "getReleasePermalink",
          summary: "Serve an immutable release permalink",
          description: "Canonical entry URL for an exact release. Nested assets live under this prefix. Unknown, malformed, cross-site, or traversal release IDs return 404 and never fall back to the current release.",
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]+$" } },
            { name: "releaseId", in: "path", required: true, schema: { type: "string", minLength: 1 } },
          ],
          responses: {
            "200": { description: "Byte-stable release asset with immutable caching" },
            "308": { description: "Redirect to the trailing-slash permalink when the slash is omitted" },
            "404": { description: "Unknown, malformed, cross-site, or traversal release; never the current release" },
          },
        },
      },
      "/api/v1/sites/{slug}/releases": {
        get: {
          operationId: "getSiteReleaseHistory",
          summary: "Get current site pointer and ordered release history",
          description: "Public metadata-only history. Does not copy or return release asset bytes. Releases are newest-first by deploy timestamp.",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
          responses: {
            "200": {
              description: "Current URL/release, file/byte totals, and ordered history",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SiteHistoryResponse" } } },
            },
            "404": {
              description: "Site not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SiteNotFoundError" } } },
            },
          },
        },
      },
      "/api/v1/sites/{slug}/rollback": {
        post: {
          operationId: "rollbackSite",
          summary: "Atomically activate a prior immutable release",
          description: "Guarded rollback: points current.json at an existing release directory without copying files. Unknown or malformed release IDs fail closed. Repeating the same target is idempotent.",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/RollbackRequest" } } },
          },
          responses: {
            "200": {
              description: "Active release after rollback (or unchanged when already active)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DeployReceipt" } } },
            },
            "401": {
              description: "Missing or invalid token",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
            },
            "403": {
              description: "Production refuses writes while a local auth bypass or insecure cookie mode is enabled",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
            },
            "404": {
              description: "Site not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SiteNotFoundError" } } },
            },
            "422": {
              description: "Unknown or malformed release id",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
            },
          },
        },
      },
      "/api/v1/sites/{slug}/deploy": {
        post: {
          operationId: "deploySite", summary: "Atomically deploy a static site", security: [{ bearerAuth: [] }],
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string", contentEncoding: "base64" } } } } } } } },
          },
          responses: {
            "201": {
              description: "Deployment created. url is the mutable current-site URL; releaseUrl is the immutable permalink for this exact release.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DeployReceipt" } } },
            },
            "401": {
              description: "Missing or invalid token",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
            },
            "403": {
              description: "Production refuses writes while a local auth bypass or insecure cookie mode is enabled",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
            },
            "413": {
              description: "Request too large",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
            },
            "422": {
              description: "Invalid deployment",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        AgentCredential: {
          type: "object", additionalProperties: false,
          required: ["id", "scope", "created_at", "last_used_at", "revoked_at"],
          properties: {
            id: { type: "string", pattern: "^[a-f0-9]{32}$", description: "Random credential identifier; not derived from the token." },
            scope: { anyOf: [{ type: "string" }, { type: "null" }], description: "Literal site-slug prefix, or null for unrestricted." },
            created_at: { type: "string", format: "date-time" },
            last_used_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
            revoked_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
          },
        },
        HealthResponse: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: {
            ok: { type: "boolean", const: true },
          },
        },
        OpenQuickRelease: {
          type: "object",
          additionalProperties: false,
          required: ["schema", "service", "sourceRevision", "builtAt", "deploymentId"],
          properties: {
            schema: { type: "string", const: "openquick-release/v1" },
            service: { type: "string", const: "openquick", description: "Stable application identity." },
            sourceRevision: {
              type: "string",
              pattern: "^[0-9a-f]{40}$",
              description: "Exact 40-character lowercase git SHA of the promoted Space-main commit. Injected at authorized build/deploy; never derived from a request or hosted file.",
            },
            builtAt: {
              type: "string",
              format: "date-time",
              description: "RFC 3339 UTC timestamp of the authorized build.",
            },
            deploymentId: {
              type: "string",
              minLength: 1,
              pattern: "^\\S{1,256}$",
              description: "Opaque operator-supplied Railway deployment or release identifier. Not a secret.",
            },
          },
        },
        SiteRecord: {
          type: "object",
          additionalProperties: false,
          required: ["slug", "releaseId", "fileCount", "totalBytes", "createdAt", "updatedAt"],
          properties: {
            slug: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" },
            releaseId: { type: "string", minLength: 1 },
            fileCount: { type: "integer", minimum: 1 },
            totalBytes: { type: "integer", minimum: 0 },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            deployedBy: { type: "string", minLength: 1, description: "Public agent handle when known. Never the deploy secret. Optional on older public-read records." },
          },
        },
        SiteListResponse: {
          type: "object",
          additionalProperties: false,
          required: ["sites"],
          properties: {
            sites: { type: "array", items: { $ref: "#/components/schemas/SiteRecord" } },
          },
        },
        SiteDetailResponse: {
          type: "object",
          additionalProperties: false,
          required: ["site"],
          properties: {
            site: { $ref: "#/components/schemas/SiteRecord" },
          },
        },
        SiteHistoryResponse: {
          type: "object",
          additionalProperties: false,
          required: ["site", "url", "releaseUrl", "fileCount", "totalBytes", "releases"],
          properties: {
            site: { $ref: "#/components/schemas/SiteRecord" },
            url: { type: "string", format: "uri", description: "Mutable current-site URL: {origin}/sites/{slug}/" },
            releaseUrl: { type: "string", format: "uri", description: "Immutable canonical URL for the active release" },
            fileCount: { type: "integer", minimum: 1 },
            totalBytes: { type: "integer", minimum: 0 },
            releases: { type: "array", items: { $ref: "#/components/schemas/SiteRecord" }, description: "Newest-first metadata for each immutable release. No asset bytes." },
          },
        },
        RollbackRequest: {
          type: "object",
          additionalProperties: false,
          required: ["releaseId"],
          properties: {
            releaseId: { type: "string", minLength: 1 },
          },
        },
        SiteNotFoundError: {
          type: "object",
          additionalProperties: false,
          required: ["error"],
          properties: {
            error: { type: "string", minLength: 1, description: "Stable public-read not-found message. No code field on this path." },
          },
        },
        DeployReceipt: {
          type: "object",
          additionalProperties: false,
          required: ["site", "url", "releaseUrl"],
          properties: {
            site: { $ref: "#/components/schemas/SiteRecord" },
            url: { type: "string", format: "uri", description: "Mutable current-site URL: {origin}/sites/{slug}/" },
            releaseUrl: { type: "string", format: "uri", description: "Immutable canonical URL for this exact release: {origin}/sites/{slug}/releases/{releaseId}/" },
          },
        },
        ErrorEnvelope: {
          type: "object",
          additionalProperties: false,
          required: ["error", "code"],
          properties: {
            error: { type: "string", minLength: 1 },
            code: {
              type: "string",
              enum: ["unauthorized", "insecure_mode", "payload_too_large", "invalid_deployment", "invalid_release", "scope_denied"],
            },
          },
        },
      },
    },
  };
}
