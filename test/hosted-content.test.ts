import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ActivationStore } from "../src/activation.js";
import { createApp, HOSTED_CONTENT_SECURITY_HEADERS } from "../src/app.js";
import { SiteStore } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openquick-headers-"));
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

function assertHostedHeaders(response: Response) {
  for (const [name, value] of Object.entries(HOSTED_CONTENT_SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value, name);
  }
}

test("hosted HTML and nested assets send path-mode security headers and cache validators", async () => {
  const { app } = await fixture();
  const deployed = await app.request("/api/v1/sites/headers/deploy", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({
      files: [
        { path: "index.html", content: b64("<h1>Headers</h1>") },
        { path: "assets/app.js", content: b64("console.log('ok')") },
      ],
    }),
  });
  assert.equal(deployed.status, 201);

  const html = await app.request("/sites/headers/");
  assert.equal(html.status, 200);
  const htmlBody = await html.text();
  assert.match(htmlBody, /<h1>Headers<\/h1>/);
  assert.match(htmlBody, /openquick-powered-by/);
  assert.match(html.headers.get("content-type") ?? "", /text\/html/);
  assertHostedHeaders(html);
  const etag = html.headers.get("etag");
  const lastModified = html.headers.get("last-modified");
  assert.ok(etag);
  assert.match(etag ?? "", /^"[0-9a-f]{64}"$/);
  assert.ok(lastModified);
  assert.ok(!Number.isNaN(Date.parse(lastModified ?? "")));

  const asset = await app.request("/sites/headers/assets/app.js");
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "console.log('ok')");
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assertHostedHeaders(asset);
  assert.match(asset.headers.get("etag") ?? "", /^"[0-9a-f]{64}"$/);
  assert.ok(asset.headers.get("last-modified"));

  const missing = await app.request("/sites/headers/missing.css");
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Site or asset not found");
  assertHostedHeaders(missing);

  const revalidated = await app.request("/sites/headers/", {
    headers: { "if-none-match": etag ?? "" },
  });
  assert.equal(revalidated.status, 304);
  assert.equal(await revalidated.text(), "");
  assertHostedHeaders(revalidated);
  assert.equal(revalidated.headers.get("etag"), etag);

  const stale = await app.request("/sites/headers/", {
    headers: { "if-none-match": '"deadbeef"' },
  });
  assert.equal(stale.status, 200);

  const byTime = await app.request("/sites/headers/assets/app.js", {
    headers: { "if-modified-since": asset.headers.get("last-modified") ?? "" },
  });
  assert.equal(byTime.status, 304);
});
