const version = "0.1.0";

export function llmsTxt(baseUrl: string): string {
  return `# OpenQuick

> Deploy a folder of static HTML, CSS, and JavaScript to a durable URL.

Status: private preview. Public discovery is open; deploy credentials are operator-provisioned.

## Start here
- [Agent entry point](${baseUrl}/agent.md): Read this first for the supported workflow and safety boundaries.
- [Join guide](${baseUrl}/join): Human-readable onboarding for agents and operators.
- [Agent skill](${baseUrl}/skill.md): Exact deploy workflow, constraints, and receipt contract.
- [Authentication](${baseUrl}/auth.md): Current credential model and safe handling rules.
- [OpenAPI](${baseUrl}/openapi.json): Machine-readable HTTP API.
- [Agent card](${baseUrl}/.well-known/agent.json): Machine-readable capability discovery.

## Public endpoints
- [Health](${baseUrl}/healthz)
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
- Public access: capability discovery, health, site listing, and hosted sites
- Write access: operator-provisioned bearer token
- Limits: static files only; maximum decoded release size is 10 MB
- Deploy behavior: one atomic release replaces the selected site slug

## Decide whether you can join

You can deploy only if your runtime can store \`OPENQUICK_TOKEN\` privately and inject it as an environment variable. Do not ask a human to paste a token into chat. Do not print, log, commit, or place a token in a URL. Send it only in an Authorization header to the exact ${baseUrl} origin and do not forward it across redirects.

If you do not have a private credential sink, stop after public discovery and tell the operator what is missing.

## First deploy

1. Read [the skill](${baseUrl}/skill.md) and [auth rules](${baseUrl}/auth.md).
2. Confirm [health](${baseUrl}/healthz) returns \`{"ok":true}\`.
3. Ask the operator to provision \`OPENQUICK_TOKEN\` into your private environment. Self-service activation is not live yet.
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
   # OPENQUICK_TOKEN must already be injected privately. Never echo it.
   node dist/cli.js deploy ./path/to/folder --site my-site
   \`\`\`

6. Verify the returned URL with a GET request. Report the site slug, public URL, release ID, file count, and verification timestamp to the operator.

## Good first test

Deploy a disposable slug, verify its HTML and one linked asset, redeploy a changed version to the same slug, and confirm the URL now serves the new release. Do not overwrite a slug you do not own.

## Machine-readable resources

- ${baseUrl}/llms.txt
- ${baseUrl}/skill.md
- ${baseUrl}/openapi.json
- ${baseUrl}/.well-known/agent.json
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
- The decoded release must be 10 MB or smaller.
- Site slugs use lowercase letters, numbers, and hyphens.
- \`OPENQUICK_HOST\` must be \`${baseUrl}\` for production.
- \`OPENQUICK_TOKEN\` must come from a private credential store. Never request or reveal it in chat.

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
6. GET the returned public URL and verify expected content.
7. Return a receipt containing: slug, URL, release ID, file count, verification timestamp, and observed result.

## Constraints

- OpenQuick hosts static assets; it does not run server-side code.
- A deploy replaces the current release at that slug. Confirm ownership before overwriting.
- Never send the bearer token to another host or through a redirect.
- Do not claim success until the public URL has been checked.

## API

Read ${baseUrl}/openapi.json for request and response schemas. Public discovery and reads need no token; deploys use bearer authentication.
`;
}

export function authMarkdown(baseUrl: string): string {
  return `# OpenQuick authentication

OpenQuick is currently a private preview.

## Available now

An operator provisions a deploy credential outside the conversation and stores it as \`OPENQUICK_TOKEN\` in the agent runtime. The CLI sends it as \`Authorization: Bearer ...\` only to ${baseUrl}.

## Safety rules

- Never ask for, paste, print, log, commit, or publish the token.
- Never put it in a URL, prompt, task, Resource, screenshot, or example file.
- Do not forward credentials across redirects.
- Stop after a 401 and ask the operator to repair the private connection.
- Use a disposable site slug for initial testing.

## Not live yet

Self-service agent activation, scoped per-agent keys, expiry, and revocation UI are planned but not implemented. Until then, joining requires an operator-managed private credential. See ${baseUrl}/agent.md for the exact first-deploy flow.
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
    capabilities: {
      public: ["health", "list_sites", "read_site"],
      authenticated: ["deploy_static_site"],
      planned: ["operator_approved_agent_activation", "scoped_credentials", "mcp"],
    },
  };
}

export function openApiDocument(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenQuick API",
      version,
      description: "Public discovery and authenticated atomic deploys for static sites.",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/healthz": {
        get: { operationId: "getHealth", summary: "Check service health", responses: { "200": { description: "Healthy" } } },
      },
      "/api/v1/sites": {
        get: { operationId: "listSites", summary: "List deployed sites", responses: { "200": { description: "Site list" } } },
      },
      "/api/v1/sites/{slug}": {
        get: {
          operationId: "getSite", summary: "Get site metadata",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
          responses: { "200": { description: "Site metadata" }, "404": { description: "Site not found" } },
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
            "201": { description: "Deployment created" }, "401": { description: "Missing or invalid token" },
            "413": { description: "Request too large" }, "422": { description: "Invalid deployment" },
          },
        },
      },
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  };
}
