import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ActivationStore } from "../src/activation.js";
import { evaluateWriteGate, INSECURE_MODE_ERROR, localRedirectPath } from "../src/auth-gate.js";
import { createApp } from "../src/app.js";
import { loadBootConfig } from "../src/boot.js";
import { SiteStore } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(overrides: { production?: boolean; authBypass?: boolean; insecureCookies?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "openquick-auth-gate-"));
  roots.push(root);
  const store = new SiteStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  const app = createApp({ store, activations, adminToken: "test-token", baseUrl: "https://openquick.test", ...overrides });
  return { app, activations };
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64");
}

const files = [{ path: "index.html", content: b64("<h1>Hello</h1>") }];

test("missing bearer on collection and deploy writes fails closed with 401 and does not redirect", async () => {
  const { app } = await fixture();
  for (const path of ["/api/v1/sites", "/api/v1/sites/demo/deploy", "/api/v1/sites/demo/rollback"]) {
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get("location"), null, path);
    const body = await response.json() as { error: string; code: string };
    assert.deepEqual(body, { error: "A valid deploy token is required", code: "unauthorized" });
  }
  const put = await app.request("/api/v1/sites/demo", { method: "PUT", body: "{}" });
  assert.equal(put.status, 401);
  assert.equal(put.headers.get("location"), null);
});

test("denied and invalid tokens fail closed with 401", async () => {
  const { app } = await fixture();
  for (const token of ["invalid-token", "oqt_not-a-real-token"]) {
    const response = await app.request("/api/v1/sites/demo/deploy", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    assert.equal(response.status, 401, token);
    const body = await response.json() as { code: string; token?: string };
    assert.equal(body.code, "unauthorized");
    assert.equal(body.token, undefined);
  }
});

test("valid bearer deploy is attributed to the public handle only", async () => {
  const { app } = await fixture();
  const started = await (await app.request("/api/v1/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "gate-agent", privateSink: true }),
  })).json() as { id: string; clientSecret: string };
  assert.equal((await app.request(`/api/v1/agent-connections/${started.id}/approve`, { method: "POST" })).status, 200);
  const credential = await (await app.request(`/api/v1/agent-connections/${started.id}/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientSecret: started.clientSecret }),
  })).json() as { token: string; handle: string };
  assert.equal(credential.handle, "gate-agent");
  const deployed = await app.request("/api/v1/sites/attributed/deploy", {
    method: "POST",
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });
  assert.equal(deployed.status, 201);
  const receipt = await deployed.json() as { site: { deployedBy: string } };
  assert.equal(receipt.site.deployedBy, "gate-agent");
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /clientSecret|oqt_/);
  assert.equal("email" in receipt.site, false);
  assert.equal("session" in receipt.site, false);
  assert.equal("token" in receipt, false);
  const page = await app.request("/sites/attributed/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1>Hello<\/h1>/);
});

test("production refuses writes when auth bypass or insecure cookies are enabled", async () => {
  const denied = evaluateWriteGate({ production: true, authBypass: true, insecureCookies: false }, { handle: "operator" });
  assert.equal(denied.ok, false);
  if (denied.ok) throw new Error("expected deny");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "insecure_mode");
  assert.equal(denied.body.error, INSECURE_MODE_ERROR);
  for (const flags of [
    { production: true as const, authBypass: true },
    { production: true as const, insecureCookies: true },
    { production: true as const, authBypass: true, insecureCookies: true },
  ]) {
    const { app } = await fixture(flags);
    assert.equal((await app.request("/healthz")).status, 200);
    assert.equal((await app.request("/api/v1/sites")).status, 200);
    const response = await app.request("/api/v1/sites/bypass/deploy", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("location"), null);
    const body = await response.json() as { code: string; error: string };
    assert.equal(body.code, "insecure_mode");
    assert.equal(body.error, INSECURE_MODE_ERROR);
    const collection = await app.request("/api/v1/sites", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(collection.status, 403);
  }
});

test("non-production bypass flags do not skip bearer auth", async () => {
  const { app } = await fixture({ production: false, authBypass: true, insecureCookies: true });
  const missing = await app.request("/api/v1/sites/demo/deploy", { method: "POST", body: "{}" });
  assert.equal(missing.status, 401);
  const ok = await app.request("/api/v1/sites/demo/deploy", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });
  assert.equal(ok.status, 201);
});

test("redirect state cannot become an open redirect", async () => {
  const { app } = await fixture();
  const evil = "https://evil.example/phish";
  const slashless = await app.request(`/sites/demo?redirect=${encodeURIComponent(evil)}&state=${encodeURIComponent(evil)}`);
  assert.equal(slashless.status, 308);
  assert.equal(slashless.headers.get("location"), "/sites/demo/");
  const started = await (await app.request("/api/v1/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "redirect-agent", privateSink: true }),
  })).json() as { id: string };
  const connect = await app.request(`/connect/${started.id}?redirect=${encodeURIComponent(evil)}&state=${encodeURIComponent(evil)}`);
  assert.equal(connect.status, 200);
  assert.equal(connect.headers.get("location"), null);
  const html = await connect.text();
  assert.doesNotMatch(html, /evil\.example/);
  assert.match(html, /Approve redirect-agent/);
  assert.equal(localRedirectPath("/sites/demo/"), "/sites/demo/");
  assert.throws(() => localRedirectPath("https://evil.example/"));
  assert.throws(() => localRedirectPath("//evil.example/"));
});

test("loadBootConfig records bypass flags without defaulting them on", () => {
  const local = loadBootConfig({ OPENQUICK_ADMIN_TOKEN: "dev-token" });
  assert.equal(local.production, false);
  assert.equal(local.authBypass, false);
  assert.equal(local.insecureCookies, false);
  const production = loadBootConfig({
    NODE_ENV: "production",
    OPENQUICK_ADMIN_TOKEN: "prod-token",
    OPENQUICK_AUTH_BYPASS: "true",
    OPENQUICK_INSECURE_COOKIES: "1",
    OPENQUICK_SOURCE_REVISION: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    OPENQUICK_BUILT_AT: "2026-09-02T14:00:00Z",
    OPENQUICK_DEPLOYMENT_ID: "dep-test",
  });
  assert.equal(production.production, true);
  assert.equal(production.authBypass, true);
  assert.equal(production.insecureCookies, true);
});

