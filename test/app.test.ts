import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createApp } from "../src/app.js";
import { SiteStore } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openquick-test-"));
  roots.push(root);
  const store = new SiteStore(root);
  await store.initialize();
  return createApp({ store, adminToken: "test-token", baseUrl: "https://openquick.test" });
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
