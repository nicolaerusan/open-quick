import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
import { STORAGE_PREFIX } from "../src/storage.js";
import { SiteStore, createFilesystemStorage } from "../src/store.js";
import type { SiteRecord } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function b64(value: string): string {
  return Buffer.from(value).toString("base64");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openquick-storage-"));
  roots.push(root);
  const store = createFilesystemStorage(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  const app = createApp({ store, activations, adminToken: "test-token", baseUrl: "https://openquick.test" });
  return { app, store, root };
}

async function deploy(app: ReturnType<typeof createApp>, slug: string, html: string) {
  const response = await app.request(`/api/v1/sites/${slug}/deploy`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ files: [{ path: "index.html", content: b64(html) }] }),
  });
  assert.equal(response.status, 201);
  return await response.json() as { url: string; site: SiteRecord };
}

test("fresh deploy uses the filesystem adapter and keeps folder-to-URL contract", async () => {
  const { app } = await fixture();
  const receipt = await deploy(app, "alpha", "<h1>Alpha</h1>");
  assert.equal(receipt.url, "https://openquick.test/sites/alpha/");
  const page = await app.request("/sites/alpha/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Alpha/);
});

test("redeploy keeps the public URL while the first release permalink still serves old bytes", async () => {
  const { app } = await fixture();
  const first = await deploy(app, "story", "<h1>One</h1>");
  const second = await deploy(app, "story", "<h1>Two</h1>");
  assert.equal(first.url, second.url);
  assert.notEqual(first.site.releaseId, second.site.releaseId);
  const live = await app.request("/sites/story/");
  assert.match(await live.text(), /Two/);
  const permalink = await app.request(`/sites/story/releases/${first.site.releaseId}/`);
  assert.equal(permalink.status, 200);
  assert.match(await permalink.text(), /One/);
});

test("interrupted upload never swaps current.json and cleans pointer staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "openquick-interrupt-"));
  roots.push(root);
  class InterruptStore extends SiteStore {
    failNextActivate = false;
    protected override async activateRelease(siteRoot: string, record: SiteRecord): Promise<void> {
      if (this.failNextActivate) throw new Error("injected interrupt");
      return super.activateRelease(siteRoot, record);
    }
  }
  const store = new InterruptStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  const first = await store.deploy("story", [{ path: "index.html", content: b64("<h1>Keep</h1>") }], "tester");
  const pointer = join(root, "sites", "story", STORAGE_PREFIX.activePointer);
  const before = await readFile(pointer, "utf8");
  const beforeStat = await stat(pointer);
  store.failNextActivate = true;
  await assert.rejects(() => store.deploy("story", [{ path: "index.html", content: b64("<h1>Lost</h1>") }], "tester"));
  const after = await store.site("story");
  assert.equal(after.releaseId, first.releaseId);
  assert.equal(await readFile(pointer, "utf8"), before);
  const afterStat = await stat(pointer);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  const siteFiles = await readdir(join(root, "sites", "story"));
  assert.equal(siteFiles.some((name) => name.startsWith(".current-") && name !== "current.json"), false);
});

test("cleanupOrphans removes planted partials without touching the active pointer or other sites", async () => {
  const { store, root } = await fixture();
  await store.deploy("alpha", [{ path: "index.html", content: b64("<h1>A</h1>") }], "tester");
  await store.deploy("bravo", [{ path: "index.html", content: b64("<h1>B</h1>") }], "tester");
  const alphaPointer = await store.site("alpha");
  const bravoPointer = await store.site("bravo");
  const crash = join(root, "sites", "alpha", "releases", ".upload-crash");
  await mkdir(crash, { recursive: true });
  await writeFile(join(crash, "junk.txt"), "partial");
  await writeFile(join(root, "sites", "alpha", ".current-partial.json"), "{}");
  const result = await store.cleanupOrphans();
  assert.ok(result.removed.some((path) => path.includes(".upload-crash")));
  assert.ok(result.removed.some((path) => path.includes(".current-partial.json")));
  assert.equal((await store.site("alpha")).releaseId, alphaPointer.releaseId);
  assert.equal((await store.site("bravo")).releaseId, bravoPointer.releaseId);
  await assert.rejects(() => stat(crash));
});

test("cross-site isolation: one site cannot read another site's release objects", async () => {
  const { store } = await fixture();
  const alpha = await store.deploy("alpha", [{ path: "index.html", content: b64("<h1>A</h1>") }], "tester");
  const bravo = await store.deploy("bravo", [{ path: "index.html", content: b64("<h1>B</h1>") }], "tester");
  await assert.rejects(() => store.assetAtRelease("alpha", bravo.releaseId, "index.html"));
  const a = await store.asset("alpha", "index.html");
  assert.match(Buffer.from(a.bytes).toString(), /A/);
  const b = await store.asset("bravo", "index.html");
  assert.match(Buffer.from(b.bytes).toString(), /B/);
});

test("initialize sweeps planted orphans", async () => {
  const { store, root } = await fixture();
  await store.deploy("alpha", [{ path: "index.html", content: b64("<h1>A</h1>") }], "tester");
  const crash = join(root, "sites", "alpha", "releases", ".upload-boot");
  await mkdir(crash, { recursive: true });
  await writeFile(join(crash, "x.txt"), "x");
  const again = createFilesystemStorage(root);
  await again.initialize();
  await assert.rejects(() => stat(crash));
  assert.equal((await again.site("alpha")).slug, "alpha");
});
