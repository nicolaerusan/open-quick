import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
import { SiteStore } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openquick-activation-"));
  roots.push(root);
  const store = new SiteStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  return { app: createApp({ store, activations, adminToken: "test-token", baseUrl: "https://openquick.test" }), activations };
}

test("fails closed without a private sink", async () => {
  const { app } = await fixture();
  const response = await app.request("/api/v1/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "cold-agent" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { code: string };
  assert.equal(body.code, "no_private_sink");
});

test("pending poll never returns a deploy token", async () => {
  const { app } = await fixture();
  const started = await app.request("/api/v1/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "cold-agent", privateSink: true }),
  });
  assert.equal(started.status, 201);
  const pending = await started.json() as {
    id: string;
    clientSecret: string;
    approvalUrl: string;
    token?: string;
  };
  assert.equal(pending.token, undefined);
  assert.equal(pending.approvalUrl, `https://openquick.test/connect/${pending.id}`);
  assert.doesNotMatch(pending.approvalUrl, /oqt_/);

  const polled = await app.request(`/api/v1/agent-connections/${pending.id}/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientSecret: pending.clientSecret }),
  });
  assert.equal(polled.status, 200);
  const body = await polled.json() as { status: string; token?: string };
  assert.equal(body.status, "pending");
  assert.equal(body.token, undefined);
});

test("approval delivers a one-time token that can deploy and is attributed by handle", async () => {
  const { app } = await fixture();
  const started = await (await app.request("/api/v1/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "cold-agent", privateSink: true }),
  })).json() as { id: string; clientSecret: string };

  const page = await app.request(`/connect/${started.id}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Approve cold-agent/);
  assert.doesNotMatch(html, /oqt_/);

  const approved = await app.request(`/api/v1/agent-connections/${started.id}/approve`, { method: "POST" });
  assert.equal(approved.status, 200);
  const approvedBody = await approved.json() as { token?: string; handle: string };
  assert.equal(approvedBody.handle, "cold-agent");
  assert.equal(approvedBody.token, undefined);

  const first = await app.request(`/api/v1/agent-connections/${started.id}/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientSecret: started.clientSecret }),
  });
  assert.equal(first.status, 200);
  const credential = await first.json() as { status: string; token: string; handle: string };
  assert.equal(credential.status, "approved");
  assert.equal(credential.handle, "cold-agent");
  assert.match(credential.token, /^oqt_/);

  const replay = await app.request(`/api/v1/agent-connections/${started.id}/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientSecret: started.clientSecret }),
  });
  assert.equal(replay.status, 409);
  const replayBody = await replay.json() as { code: string; token?: string };
  assert.equal(replayBody.code, "replay");
  assert.equal(replayBody.token, undefined);

  const deployed = await app.request("/api/v1/sites/from-agent/deploy", {
    method: "POST",
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    body: JSON.stringify({ files: [{ path: "index.html", content: Buffer.from("<h1>Agent</h1>").toString("base64") }] }),
  });
  assert.equal(deployed.status, 201);
  const receipt = await deployed.json() as { site: { deployedBy: string }; url: string };
  assert.equal(receipt.site.deployedBy, "cold-agent");
  assert.doesNotMatch(JSON.stringify(receipt), /oqt_/);

  const publicRead = await app.request("/sites/from-agent/");
  assert.equal(publicRead.status, 200);
  assert.match(await publicRead.text(), /<h1>Agent<\/h1>/);

  const listed = await (await app.request("/api/v1/sites")).json() as { sites: Array<{ deployedBy: string }> };
  assert.equal(listed.sites[0]?.deployedBy, "cold-agent");
});

test("expired activations fail closed", async () => {
  const { activations } = await fixture();
  const origin = "https://openquick.test";
  const started = await activations.start({ handle: "late-agent", privateSink: true, origin });
  const later = Date.parse(started.expiresAt) + 1;
  const polled = await activations.poll(started.id, started.clientSecret, later);
  assert.equal(polled.status, "expired");
  assert.equal(polled.token, undefined);
  await assert.rejects(() => activations.approve(started.id, origin, later), /expired/i);
});

test("approve replay fails closed", async () => {
  const { app } = await fixture();
  const started = await (await app.request("/api/v1/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "once-agent", privateSink: true }),
  })).json() as { id: string };
  assert.equal((await app.request(`/api/v1/agent-connections/${started.id}/approve`, { method: "POST" })).status, 200);
  const second = await app.request(`/api/v1/agent-connections/${started.id}/approve`, { method: "POST" });
  assert.equal(second.status, 409);
  assert.equal(((await second.json()) as { code: string }).code, "replay");
});

test("wrong poll secret fails closed", async () => {
  const { app } = await fixture();
  const started = await (await app.request("/api/v1/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "secret-agent", privateSink: true }),
  })).json() as { id: string };
  const response = await app.request(`/api/v1/agent-connections/${started.id}/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientSecret: "ocs_invalid" }),
  });
  assert.equal(response.status, 401);
});
