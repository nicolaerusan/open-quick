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
  const root = await mkdtemp(join(tmpdir(), "openquick-test-"));
  roots.push(root);
  const store = new SiteStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  return createApp({ store, activations, adminToken: "test-token", baseUrl: "https://openquick.test" });
}

test("deploys and serves a static site", async () => {
  const app = await fixture();
  const unauthorized = await app.request("/api/v1/sites/demo/deploy", { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401);

  const deployed = await app.request("/api/v1/sites/demo/deploy", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ files: [{ path: "index.html", content: Buffer.from("<h1>Hello</h1>").toString("base64") }] }),
  });
  assert.equal(deployed.status, 201);
  assert.equal((await deployed.json()).url, "https://openquick.test/sites/demo/");

  const page = await app.request("/sites/demo/");
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<h1>Hello</h1>");
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
});

test("rejects unsafe paths without replacing the current release", async () => {
  const app = await fixture();
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  const good = await app.request("/api/v1/sites/safe/deploy", {
    method: "POST", headers,
    body: JSON.stringify({ files: [{ path: "index.html", content: Buffer.from("safe").toString("base64") }] }),
  });
  assert.equal(good.status, 201);
  const bad = await app.request("/api/v1/sites/safe/deploy", {
    method: "POST", headers,
    body: JSON.stringify({ files: [{ path: "../escape.txt", content: Buffer.from("nope").toString("base64") }] }),
  });
  assert.equal(bad.status, 422);
  assert.equal(await (await app.request("/sites/safe/")).text(), "safe");
});

test("publishes an agent-first discovery surface", async () => {
  const app = await fixture();

  const agent = await app.request("/agent.md");
  assert.equal(agent.status, 200);
  assert.match(agent.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(await agent.text(), /Join OpenQuick as an agent/);

  const skill = await app.request("/skill.md");
  assert.equal(skill.status, 200);
  assert.match(await skill.text(), /name: openquick/);

  const llms = await app.request("/llms.txt");
  assert.match(await llms.text(), /https:\/\/openquick\.test\/openapi\.json/);

  const card = await (await app.request("/.well-known/agent.json")).json() as { status: string; skill: string };
  assert.equal(card.status, "private_preview");
  assert.equal(card.skill, "https://openquick.test/skill.md");

  const openapi = await (await app.request("/openapi.json")).json() as { openapi: string; paths: Record<string, unknown> };
  assert.equal(openapi.openapi, "3.1.0");
  assert.ok(openapi.paths["/api/v1/sites/{slug}/deploy"]);

  const join = await app.request("/join");
  assert.equal(join.status, 200);
  assert.match(await join.text(), /COPY THIS TO AN AGENT/);
});
