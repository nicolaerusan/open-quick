import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
import {
  POWERED_BY_ROOT_ID,
  POWERED_BY_STORAGE_KEY,
  injectPoweredByBadge,
  maybeInjectHostedHtml,
  shouldInjectBadge,
} from "../src/powered-by.js";
import { SiteStore } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openquick-badge-"));
  roots.push(root);
  const store = new SiteStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  const app = createApp({ store, activations, adminToken: "test-token", baseUrl: "https://openquick.test" });
  return { app };
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
  return await response.json() as { site: { releaseId: string }; url: string };
}

test("shouldInjectBadge honors meta opt-out regardless of attribute order or case", () => {
  assert.equal(shouldInjectBadge("<h1>Hello</h1>"), true);
  assert.equal(shouldInjectBadge(`<html><head><meta name="openquick-badge" content="off"></head><body>x</body></html>`), false);
  assert.equal(shouldInjectBadge(`<html><head><meta content="OFF" name="OpenQuick-Badge"></head><body>x</body></html>`), false);
  assert.equal(shouldInjectBadge(`<html><head><meta name="openquick-badge" content="on"></head><body>x</body></html>`), true);
});

test("injectPoweredByBadge adds compact chip, popover links, dismiss storage, and reduced-motion CSS", () => {
  const html = injectPoweredByBadge("<!doctype html><html><body><h1>Hi</h1></body></html>", { origin: "https://openquick.test" });
  assert.match(html, /<h1>Hi<\/h1>/);
  assert.match(html, new RegExp(`id="${POWERED_BY_ROOT_ID}"`));
  assert.match(html, /Powered by OpenQuick/);
  assert.match(html, /https:\/\/openquick\.test\//);
  assert.match(html, /https:\/\/openquick\.test\/agent\.md/);
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
  assert.match(html, new RegExp(POWERED_BY_STORAGE_KEY));
  assert.match(html, /data-oq-dismiss/);
  assert.match(html, /<svg[\s\S]*#c9ff38/);
  assert.doesNotMatch(html, /Bearer |oqt_|OPENQUICK_TOKEN|test-token/);
  assert.match(html, /max-width:\s*640px/);
  const once = html.split(POWERED_BY_ROOT_ID).length - 1;
  const twice = injectPoweredByBadge(html, { origin: "https://openquick.test" }).split(POWERED_BY_ROOT_ID).length - 1;
  assert.equal(once, twice);
});

test("maybeInjectHostedHtml leaves non-HTML bytes unchanged", () => {
  const json = new TextEncoder().encode('{"ok":true}');
  assert.equal(maybeInjectHostedHtml(json, "application/json", "https://openquick.test", undefined), json);
  const js = new TextEncoder().encode("console.log(1)");
  assert.equal(maybeInjectHostedHtml(js, "text/javascript", "https://openquick.test", undefined), js);
  const html = new TextEncoder().encode("<h1>x</h1>");
  const skipped = maybeInjectHostedHtml(html, "text/html", "https://openquick.test", "off");
  assert.equal(skipped, html);
});

test("hosted HTML 200 includes badge markup and no secrets; JSON and JS stay raw", async () => {
  const { app } = await fixture();
  const deployed = await deploy(app, "badge-demo", [
    { path: "index.html", content: "<h1>Live</h1>" },
    { path: "data.json", content: '{"n":1}' },
    { path: "app.js", content: "console.log('ok')" },
  ]);

  const page = await app.request("/sites/badge-demo/");
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /<h1>Live<\/h1>/);
  assert.match(body, /openquick-powered-by/);
  assert.match(body, /https:\/\/openquick\.test\//);
  assert.match(body, /https:\/\/openquick\.test\/agent\.md/);
  assert.doesNotMatch(body, /Bearer |oqt_|OPENQUICK_TOKEN|test-token/);

  const json = await app.request("/sites/badge-demo/data.json");
  assert.equal(json.status, 200);
  assert.equal(await json.text(), '{"n":1}');

  const script = await app.request("/sites/badge-demo/app.js");
  assert.equal(script.status, 200);
  assert.equal(await script.text(), "console.log('ok')");

  const api = await app.request("/api/v1/sites/badge-demo");
  assert.equal(api.status, 200);
  const payload = await api.text();
  assert.equal(payload.includes("openquick-powered-by"), false);
  assert.match(payload, /"slug":"badge-demo"/);

  const permalink = await app.request(`/sites/badge-demo/releases/${deployed.site.releaseId}/`);
  assert.equal(permalink.status, 200);
  assert.match(await permalink.text(), /openquick-powered-by/);
});

test("meta opt-out and X-OpenQuick-Badge header skip injection", async () => {
  const { app } = await fixture();
  await deploy(app, "opt-out", [
    { path: "index.html", content: `<!doctype html><html><head><meta name="openquick-badge" content="off"></head><body><h1>Quiet</h1></body></html>` },
  ]);
  const skipped = await app.request("/sites/opt-out/");
  assert.equal(skipped.status, 200);
  const skippedBody = await skipped.text();
  assert.match(skippedBody, /<h1>Quiet<\/h1>/);
  assert.doesNotMatch(skippedBody, /openquick-powered-by/);

  await deploy(app, "header-off", [{ path: "index.html", content: "<h1>Header</h1>" }]);
  const viaHeader = await app.request("/sites/header-off/", { headers: { "x-openquick-badge": "off" } });
  assert.equal(viaHeader.status, 200);
  assert.equal(await viaHeader.text(), "<h1>Header</h1>");
});

test("ETag is hashed after injection and 304 matches injected bytes", async () => {
  const { app } = await fixture();
  await deploy(app, "etag-badge", [{ path: "index.html", content: "<h1>Hash</h1>" }]);
  const raw = new TextEncoder().encode("<h1>Hash</h1>");
  const rawTag = `"${crypto.createHash("sha256").update(raw).digest("hex")}"`;
  const page = await app.request("/sites/etag-badge/");
  assert.equal(page.status, 200);
  const body = await page.text();
  const injectedTag = `"${crypto.createHash("sha256").update(body).digest("hex")}"`;
  assert.equal(page.headers.get("etag"), injectedTag);
  assert.notEqual(injectedTag, rawTag);

  const revalidated = await app.request("/sites/etag-badge/", { headers: { "if-none-match": injectedTag } });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get("etag"), injectedTag);
});

test("hosted 404 plain text is not injected", async () => {
  const { app } = await fixture();
  await deploy(app, "present", [{ path: "index.html", content: "<h1>Here</h1>" }]);
  const missing = await app.request("/sites/present/missing.html");
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Site or asset not found");
});
