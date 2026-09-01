import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
import { SiteStore, isValidReleaseId } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openquick-test-"));
  roots.push(root);
  const store = new SiteStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  const app = createApp({ store, activations, adminToken: "test-token", baseUrl: "https://openquick.test" });
  return { app, store };
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64");
}

async function deploy(app: ReturnType<typeof createApp>, slug: string, files: Array<{ path: string; content: string }>) {
  const response = await app.request(`/api/v1/sites/${slug}/deploy`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ files: files.map((file) => ({ path: file.path, content: b64(file.content) })) }),
  });
  assert.equal(response.status, 201);
  return await response.json() as {
    url: string;
    releaseUrl: string;
    site: { slug: string; releaseId: string };
  };
}

test("deploys and serves a static site", async () => {
  const { app } = await fixture();
  const unauthorized = await app.request("/api/v1/sites/demo/deploy", { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401);

  const deployed = await app.request("/api/v1/sites/demo/deploy", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ files: [{ path: "index.html", content: b64("<h1>Hello</h1>") }] }),
  });
  assert.equal(deployed.status, 201);
  const receipt = await deployed.json() as { url: string; releaseUrl: string; site: { releaseId: string } };
  assert.equal(receipt.url, "https://openquick.test/sites/demo/");
  assert.equal(receipt.releaseUrl, `https://openquick.test/sites/demo/releases/${receipt.site.releaseId}/`);

  const page = await app.request("/sites/demo/");
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<h1>Hello</h1>");
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
});

test("rejects unsafe paths without replacing the current release", async () => {
  const { app } = await fixture();
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  const good = await app.request("/api/v1/sites/safe/deploy", {
    method: "POST", headers,
    body: JSON.stringify({ files: [{ path: "index.html", content: b64("safe") }] }),
  });
  assert.equal(good.status, 201);
  const bad = await app.request("/api/v1/sites/safe/deploy", {
    method: "POST", headers,
    body: JSON.stringify({ files: [{ path: "../escape.txt", content: b64("nope") }] }),
  });
  assert.equal(bad.status, 422);
  assert.equal(await (await app.request("/sites/safe/")).text(), "safe");
});

test("publishes an agent-first discovery surface", async () => {
  const { app } = await fixture();

  const agent = await app.request("/agent.md");
  assert.equal(agent.status, 200);
  assert.match(agent.headers.get("content-type") ?? "", /text\/markdown/);
  const agentText = await agent.text();
  assert.match(agentText, /Join OpenQuick as an agent/);
  assert.match(agentText, /Immutable release permalink/);
  assert.match(agentText, /\/sites\/\{slug\}\/releases\/\{releaseId\}\//);

  const skill = await app.request("/skill.md");
  assert.equal(skill.status, 200);
  const skillText = await skill.text();
  assert.match(skillText, /name: openquick/);
  assert.match(skillText, /immutable `\/sites\/\{slug\}\/releases\/\{releaseId\}\//);

  const llms = await app.request("/llms.txt");
  assert.match(await llms.text(), /https:\/\/openquick\.test\/openapi\.json/);

  const card = await (await app.request("/.well-known/agent.json")).json() as { status: string; skill: string };
  assert.equal(card.status, "private_preview");
  assert.equal(card.skill, "https://openquick.test/skill.md");

  const openapi = await (await app.request("/openapi.json")).json() as { openapi: string; paths: Record<string, unknown> };
  assert.equal(openapi.openapi, "3.1.0");
  assert.ok(openapi.paths["/api/v1/sites/{slug}/deploy"]);
  assert.ok(openapi.paths["/sites/{slug}/releases/{releaseId}/"]);

  const join = await app.request("/join");
  assert.equal(join.status, 200);
  assert.match(await join.text(), /COPY THIS TO AN AGENT/);
});

test("keeps prior release permalinks after a later deploy", async () => {
  const { app } = await fixture();
  const first = await deploy(app, "story", [
    { path: "index.html", content: "<h1>First</h1>" },
    { path: "assets/app.js", content: "console.log('first')" },
  ]);
  const second = await deploy(app, "story", [
    { path: "index.html", content: "<h1>Second</h1>" },
    { path: "assets/app.js", content: "console.log('second')" },
  ]);
  assert.notEqual(first.site.releaseId, second.site.releaseId);
  assert.equal(first.url, second.url);
  assert.equal(first.url, "https://openquick.test/sites/story/");
  assert.equal(first.releaseUrl, `https://openquick.test/sites/story/releases/${first.site.releaseId}/`);
  assert.equal(second.releaseUrl, `https://openquick.test/sites/story/releases/${second.site.releaseId}/`);

  const current = await app.request("/sites/story/");
  assert.equal(current.status, 200);
  assert.equal(await current.text(), "<h1>Second</h1>");
  assert.equal(current.headers.get("cache-control"), "no-cache");
  assert.equal(current.headers.get("x-content-type-options"), "nosniff");

  const previous = await app.request(`/sites/story/releases/${first.site.releaseId}/`);
  assert.equal(previous.status, 200);
  assert.equal(await previous.text(), "<h1>First</h1>");
  assert.equal(previous.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(previous.headers.get("x-content-type-options"), "nosniff");
  assert.match(previous.headers.get("content-type") ?? "", /text\/html/);

  const nested = await app.request(`/sites/story/releases/${first.site.releaseId}/assets/app.js`);
  assert.equal(nested.status, 200);
  assert.equal(await nested.text(), "console.log('first')");
  assert.match(nested.headers.get("content-type") ?? "", /javascript/);
  assert.equal(nested.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const currentNested = await app.request("/sites/story/assets/app.js");
  assert.equal(await currentNested.text(), "console.log('second')");
  assert.equal(currentNested.headers.get("cache-control"), "public, max-age=300");

  const slashless = await app.request(`/sites/story/releases/${first.site.releaseId}`);
  assert.equal(slashless.status, 308);
  assert.equal(slashless.headers.get("location"), `/sites/story/releases/${first.site.releaseId}/`);
});

test("rejects malformed release ids at the store boundary", () => {
  for (const id of ["", "..", "../", "foo/bar", "foo\\bar", ".upload-temp", ".upload-abc", "a/../b", "rel\0id", "has space"]) {
    assert.equal(isValidReleaseId(id), false, id);
  }
  assert.equal(isValidReleaseId("mtifcsbk-1a09c80c3c"), true);
});

test("release permalinks 404 without falling back to the current release", async () => {
  const { app, store } = await fixture();
  const alpha = await deploy(app, "alpha", [{ path: "index.html", content: "<h1>Alpha current</h1>" }]);
  const bravo = await deploy(app, "bravo", [{ path: "index.html", content: "<h1>Bravo current</h1>" }]);
  const current = "<h1>Alpha current</h1>";

  async function must404(path: string) {
    const response = await app.request(path);
    const body = await response.text();
    assert.equal(response.status, 404, path);
    assert.notEqual(body, current, path);
    assert.notEqual(body, "<h1>Bravo current</h1>", path);
  }

  await must404("/sites/alpha/releases/missing-release/");
  await must404("/sites/alpha/releases/not-a-real-id/index.html");
  await must404(`/sites/alpha/releases/${bravo.site.releaseId}/`);
  await must404("/sites/alpha/releases/.upload-temp/");
  await must404("/sites/alpha/releases/.upload-abc123/");
  await must404(`/sites/alpha/releases/${encodeURIComponent("foo/bar")}/`);
  await must404(`/sites/alpha/releases/${encodeURIComponent("foo\\bar")}/`);
  await must404(`/sites/alpha/releases/${alpha.site.releaseId}/missing-asset.txt`);

  for (const releaseId of ["..", "../", "foo/bar", "foo\\bar", ".upload-temp", "", "has space"]) {
    await assert.rejects(() => store.assetAtRelease("alpha", releaseId, "index.html"));
  }
  await assert.rejects(() => store.assetAtRelease("alpha", bravo.site.releaseId, "index.html"));
  const currentAsset = await store.asset("alpha", "index.html");
  assert.equal(Buffer.from(currentAsset.bytes).toString(), current);
});
