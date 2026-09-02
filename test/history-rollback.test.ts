import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
import { SiteStore } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openquick-history-"));
  roots.push(root);
  const store = new SiteStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  const app = createApp({ store, activations, adminToken: "test-token", baseUrl: "https://openquick.test" });
  return { app, store, root };
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64");
}

async function deploy(app: ReturnType<typeof createApp>, slug: string, html: string) {
  const response = await app.request(`/api/v1/sites/${slug}/deploy`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ files: [{ path: "index.html", content: b64(html) }] }),
  });
  assert.equal(response.status, 201);
  return await response.json() as {
    url: string;
    releaseUrl: string;
    site: { slug: string; releaseId: string; fileCount: number; totalBytes: number };
  };
}

test("history lists current URL/release, totals, and newest-first order without copying bytes", async () => {
  const { app, store, root } = await fixture();
  const first = await deploy(app, "story", "<h1>First</h1>");
  const second = await deploy(app, "story", "<h1>Second</h1>");
  const third = await deploy(app, "story", "<h1>Third</h1>");
  assert.notEqual(first.site.releaseId, second.site.releaseId);
  assert.notEqual(second.site.releaseId, third.site.releaseId);

  const history = await app.request("/api/v1/sites/story/releases");
  assert.equal(history.status, 200);
  const body = await history.json() as {
    site: { releaseId: string; fileCount: number; totalBytes: number };
    url: string;
    releaseUrl: string;
    fileCount: number;
    totalBytes: number;
    releases: Array<{ releaseId: string; fileCount: number; totalBytes: number }>;
  };
  assert.equal(body.url, "https://openquick.test/sites/story/");
  assert.equal(body.site.releaseId, third.site.releaseId);
  assert.equal(body.releaseUrl, `https://openquick.test/sites/story/releases/${third.site.releaseId}/`);
  assert.equal(body.fileCount, third.site.fileCount);
  assert.equal(body.totalBytes, third.site.totalBytes);
  assert.deepEqual(body.releases.map((release) => release.releaseId), [
    third.site.releaseId,
    second.site.releaseId,
    first.site.releaseId,
  ]);
  assert.equal(JSON.stringify(body).includes("<h1>"), false);

  const releaseDirs = await readdir(join(root, "sites", "story", "releases"));
  assert.equal(releaseDirs.filter((name) => !name.startsWith(".")).length, 3);
  const fromStore = await store.history("story");
  assert.deepEqual(fromStore.map((release) => release.releaseId), body.releases.map((release) => release.releaseId));
});

test("rollback atomically activates a prior immutable release without copying files", async () => {
  const { app, store, root } = await fixture();
  const first = await deploy(app, "story", "<h1>First</h1>");
  const second = await deploy(app, "story", "<h1>Second</h1>");
  assert.match(await (await app.request("/sites/story/")).text(), /<h1>Second<\/h1>/);

  const unauthorized = await app.request("/api/v1/sites/story/rollback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ releaseId: first.site.releaseId }),
  });
  assert.equal(unauthorized.status, 401);

  const rolled = await app.request("/api/v1/sites/story/rollback", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ releaseId: first.site.releaseId }),
  });
  assert.equal(rolled.status, 200);
  const receipt = await rolled.json() as { site: { releaseId: string }; url: string; releaseUrl: string };
  assert.equal(receipt.site.releaseId, first.site.releaseId);
  assert.equal(receipt.url, "https://openquick.test/sites/story/");
  assert.equal(receipt.releaseUrl, first.releaseUrl);

  const current = await app.request("/sites/story/");
  assert.equal(current.status, 200);
  assert.match(await current.text(), /<h1>First<\/h1>/);
  assert.match(await (await app.request(first.releaseUrl.replace("https://openquick.test", ""))).text(), /<h1>First<\/h1>/);
  assert.match(await (await app.request(second.releaseUrl.replace("https://openquick.test", ""))).text(), /<h1>Second<\/h1>/);

  const releaseDirs = (await readdir(join(root, "sites", "story", "releases"))).filter((name) => !name.startsWith("."));
  assert.deepEqual(new Set(releaseDirs), new Set([first.site.releaseId, second.site.releaseId]));

  const events = await store.audit("story");
  assert.deepEqual(events.map((event) => event.type), ["deploy", "deploy", "rollback"]);
  const rollback = events[2];
  assert.equal(rollback?.type, "rollback");
  if (rollback?.type === "rollback") {
    assert.equal(rollback.fromReleaseId, second.site.releaseId);
    assert.equal(rollback.toReleaseId, first.site.releaseId);
    assert.equal(rollback.actor, "operator");
  }
});

test("unknown and malformed release ids fail closed on rollback", async () => {
  const { app, store } = await fixture();
  const alpha = await deploy(app, "alpha", "<h1>Alpha</h1>");
  const bravo = await deploy(app, "bravo", "<h1>Bravo</h1>");

  async function mustFail(releaseId: string) {
    const response = await app.request("/api/v1/sites/alpha/rollback", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ releaseId }),
    });
    assert.equal(response.status, 422, releaseId);
    const body = await response.json() as { error: string; code: string };
    assert.equal(body.code, "invalid_release");
    assert.match(await (await app.request("/sites/alpha/")).text(), /<h1>Alpha<\/h1>/);
    const current = await store.site("alpha");
    assert.equal(current.releaseId, alpha.site.releaseId);
  }

  await mustFail("missing-release");
  await mustFail(bravo.site.releaseId);
  await mustFail("..");
  await mustFail("../");
  await mustFail("foo/bar");
  await mustFail(".upload-temp");
  await mustFail("");
  await mustFail("has space");

  const missingSite = await app.request("/api/v1/sites/no-such-site/rollback", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ releaseId: alpha.site.releaseId }),
  });
  assert.equal(missingSite.status, 404);

  const events = await store.audit("alpha");
  assert.deepEqual(events.map((event) => event.type), ["deploy"]);
});

test("duplicate rollback is idempotent: same active release and no extra mutation", async () => {
  const { app, store, root } = await fixture();
  const first = await deploy(app, "story", "<h1>First</h1>");
  await deploy(app, "story", "<h1>Second</h1>");

  const firstRollback = await app.request("/api/v1/sites/story/rollback", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ releaseId: first.site.releaseId }),
  });
  assert.equal(firstRollback.status, 200);

  const pointer = join(root, "sites", "story", "current.json");
  const auditFile = join(root, "sites", "story", "audit.jsonl");
  const pointerBefore = await stat(pointer);
  const auditBefore = await stat(auditFile);
  const eventsBefore = await store.audit("story");

  const duplicate = await app.request("/api/v1/sites/story/rollback", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ releaseId: first.site.releaseId }),
  });
  assert.equal(duplicate.status, 200);
  const receipt = await duplicate.json() as { site: { releaseId: string } };
  assert.equal(receipt.site.releaseId, first.site.releaseId);
  assert.match(await (await app.request("/sites/story/")).text(), /<h1>First<\/h1>/);

  const pointerAfter = await stat(pointer);
  const auditAfter = await stat(auditFile);
  assert.equal(pointerAfter.mtimeMs, pointerBefore.mtimeMs);
  assert.equal(auditAfter.size, auditBefore.size);
  const eventsAfter = await store.audit("story");
  assert.equal(eventsAfter.length, eventsBefore.length);
  assert.deepEqual(eventsAfter.map((event) => event.type), ["deploy", "deploy", "rollback"]);
});
