import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
import { SiteStore } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openquick-credentials-"));
  roots.push(root);
  const store = new SiteStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  const app = createApp({ store, activations, adminToken: "test-token", baseUrl: "https://openquick.test" });
  return { root, app, activations };
}

async function mint(app: ReturnType<typeof createApp>, handle: string, scope: string | null = null) {
  const startResponse = await app.request("/api/v1/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, privateSink: true, scope }),
  });
  assert.equal(startResponse.status, 201);
  const started = await startResponse.json() as { id: string; clientSecret: string; scope: string | null };
  assert.equal(started.scope, scope);
  assert.equal((await app.request(`/api/v1/agent-connections/${started.id}/approve`, { method: "POST" })).status, 200);
  const poll = await app.request(`/api/v1/agent-connections/${started.id}/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientSecret: started.clientSecret }),
  });
  assert.equal(poll.status, 200);
  const delivered = await poll.json() as { token: string };
  return { id: started.id, token: delivered.token };
}

const files = [{ path: "index.html", content: Buffer.from("<h1>Credential</h1>").toString("base64") }];

async function deploy(app: ReturnType<typeof createApp>, token: string, slug: string) {
  return app.request(`/api/v1/sites/${slug}/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });
}

test("approval mints a hashed, non-expiring credential and audits mint", async () => {
  const { root, app, activations } = await fixture();
  const credential = await mint(app, "long-agent");
  assert.equal((await deploy(app, credential.token, "long-lived")).status, 201);

  const filesOnDisk = await readdir(join(root, "activations"));
  const stored = await readFile(join(root, "activations", filesOnDisk[0]!), "utf8");
  assert.doesNotMatch(stored, new RegExp(credential.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const record = JSON.parse(stored) as Record<string, unknown>;
  assert.equal(typeof record.deployTokenHash, "string");
  assert.equal("deployTokenPlain" in record, false);
  assert.equal("credentialExpiresAt" in record, false);

  const audit = await activations.audit();
  assert.equal(audit[0]?.type, "credential_mint");
  assert.equal(audit[0]?.credential_id, credential.id);
  assert.doesNotMatch(JSON.stringify(audit), /oqt_/);
});

test("owner listing exposes lifecycle metadata and no credential material", async () => {
  const { app } = await fixture();
  const credential = await mint(app, "list-agent", "team-");
  const response = await app.request("/api/v1/agent-connections", { headers: { authorization: `Bearer ${credential.token}` } });
  assert.equal(response.status, 200);
  const body = await response.json() as { handle: string; credentials: Array<Record<string, unknown>> };
  assert.equal(body.handle, "list-agent");
  assert.equal(body.credentials.length, 1);
  assert.deepEqual(Object.keys(body.credentials[0]!).sort(), ["created_at", "id", "last_used_at", "revoked_at", "scope"]);
  assert.equal(body.credentials[0]?.id, credential.id);
  assert.equal(body.credentials[0]?.scope, "team-");
  assert.equal(typeof body.credentials[0]?.created_at, "string");
  assert.equal(typeof body.credentials[0]?.last_used_at, "string");
  assert.equal(body.credentials[0]?.revoked_at, null);
  assert.doesNotMatch(JSON.stringify(body), /oqt_|deployToken|clientSecret/i);
});

test("revocation is immediate, uses typed 401, and audits revoke plus use-after-revoke", async () => {
  const { app, activations } = await fixture();
  const credential = await mint(app, "revoke-agent");
  const revoked = await app.request(`/api/v1/agent-connections/${credential.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${credential.token}` },
  });
  assert.equal(revoked.status, 204);

  const denied = await deploy(app, credential.token, "after-revoke");
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "A valid deploy token is required", code: "unauthorized" });

  const events = await activations.audit();
  assert.deepEqual(events.map((event) => event.type), ["credential_mint", "credential_revoke", "credential_use_after_revoke"]);
  assert.doesNotMatch(JSON.stringify(events), /oqt_/);
});

test("rotation overlaps: a second credential does not invalidate the first", async () => {
  const { app } = await fixture();
  const first = await mint(app, "rotate-agent");
  const second = await mint(app, "rotate-agent");
  assert.notEqual(first.id, second.id);
  assert.equal((await deploy(app, first.token, "rotation-one")).status, 201);
  assert.equal((await deploy(app, second.token, "rotation-two")).status, 201);

  const listed = await (await app.request("/api/v1/agent-connections", { headers: { authorization: `Bearer ${second.token}` } })).json() as { credentials: unknown[] };
  assert.equal(listed.credentials.length, 2);
  assert.equal((await app.request(`/api/v1/agent-connections/${first.id}`, { method: "DELETE", headers: { authorization: `Bearer ${second.token}` } })).status, 204);
  assert.equal((await deploy(app, first.token, "rotation-denied")).status, 401);
  assert.equal((await deploy(app, second.token, "rotation-still-live")).status, 201);
});

test("slug-prefix scope permits matching writes and denies others with typed 403", async () => {
  const { app } = await fixture();
  const scoped = await mint(app, "scope-agent", "owned-");
  assert.equal((await deploy(app, scoped.token, "owned-site")).status, 201);
  const denied = await deploy(app, scoped.token, "other-site");
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Deploy credential is not authorized for this site slug", code: "scope_denied" });

  const collection = await app.request("/api/v1/sites", { method: "POST", headers: { authorization: `Bearer ${scoped.token}` }, body: "{}" });
  assert.equal(collection.status, 403);
});

test("only the owning handle may list or revoke credentials", async () => {
  const { app } = await fixture();
  const owner = await mint(app, "owner-agent");
  const other = await mint(app, "other-agent");
  const otherList = await (await app.request("/api/v1/agent-connections", { headers: { authorization: `Bearer ${other.token}` } })).json() as { handle: string; credentials: Array<{ id: string }> };
  assert.equal(otherList.handle, "other-agent");
  assert.equal(otherList.credentials.some((item) => item.id === owner.id), false);
  assert.equal((await app.request(`/api/v1/agent-connections/${owner.id}`, { method: "DELETE", headers: { authorization: `Bearer ${other.token}` } })).status, 404);
  assert.equal((await deploy(app, owner.token, "owner-still-live")).status, 201);
});
