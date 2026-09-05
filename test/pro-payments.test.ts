import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Challenge, Credential } from "mppx";
import { ProPayments, type ProVerifier } from "../src/pro-payments.js";
import { SiteStore } from "../src/store.js";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const files = [{ path: "index.html", content: Buffer.from("<h1>Paid release</h1>").toString("base64") }];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "oq-pro-")); roots.push(root);
  const store = new SiteStore(root); await store.initialize();
  const activations = new ActivationStore(root); await activations.initialize();
  const config = { root, recipient: "0x1111111111111111111111111111111111111111" as const, secret: "ab".repeat(32), baseUrl: "https://openquick.test", actors: ["operator"] };
  let settlements = 0; let fail = false;
  const real = new ProPayments(config, store);
  const verifier: ProVerifier = async (order, request) => {
    if (!request.headers.get("authorization")) return real.pay(order.id, request);
    settlements++; if (fail) throw Error("Unknown network result");
    return { reference: `0x${"12".repeat(32)}`, receipt: "fixture-receipt" };
  };
  const pro = new ProPayments(config, store, verifier);
  const app = createApp({ store, activations, proPayments: pro, adminToken: "operator-key" });
  const create = (key = "purchase-one", body = files, auth = true) => app.request("/api/v1/pro-deploys", { method: "POST", headers: { ...(auth ? { authorization: "Bearer operator-key" } : {}), "idempotency-key": key, "content-type": "application/json" }, body: JSON.stringify({ files: body }) });
  const proof = async (id: string) => {
    const challenge = await pro.pay(id, new Request(`https://openquick.test/api/v1/pro-payments/${id}/pay`));
    assert.equal(challenge.status, 402);
    return Credential.serialize({ challenge: Challenge.deserialize(challenge.headers.get("www-authenticate")!), payload: { type: "transaction", signature: "mock" } });
  };
  const pay = (id: string, authorization: string) => pro.pay(id, new Request(`https://openquick.test/api/v1/pro-payments/${id}/pay`, { headers: { authorization } }));
  return { root, store, config, verifier, app, pro, create, proof, pay, count: () => settlements, fail: () => { fail = true; } };
}
test("authenticates creation, validates before charging, binds retry key to content", async () => {
  const f = await setup();
  assert.equal((await f.create("no-auth-1", files, false)).status, 404);
  assert.equal((await f.create("bad-file-1", [{ path: "../escape", content: "eA==" }])).status, 422);
  assert.equal((await f.create("bad-file-2", [{ path: "_openquick-release.json", content: "eA==" }])).status, 422);
  assert.equal((await f.create("bad-file-3", [{ path: "a", content: "eA==" }, { path: "a/b", content: "eA==" }])).status, 422);
  const order = await (await f.create()).json();
  assert.equal((await (await f.create()).json()).id, order.id);
  assert.equal((await f.create("purchase-one", [{ path: "index.html", content: "eA==" }])).status, 409);
  assert.equal((await f.store.list()).length, 0);
  const challenge = await f.app.request(`/api/v1/pro-payments/${order.id}/pay`, { headers: { authorization: "Bearer operator-key" } });
  assert.equal(challenge.status, 402);
  const parsed = Challenge.deserialize(challenge.headers.get("www-authenticate")!);
  assert.equal(parsed.request.amount, "10000");
  assert.equal(parsed.request.recipient, f.config.recipient);
  assert.equal(order.quoteVersion, 1); assert.equal(order.amountAtomic, "10000");
  assert.equal(f.pro.read(order.id).quote.product, "public-release");
  assert.equal(f.pro.read(order.id).quote.termDays, 0);
  assert.equal(f.count(), 0);
});
test("publishes once after confirmation, persists retry across restart, protects paid release", async () => {
  const f = await setup(); const order = await (await f.create()).json(); const proof = await f.proof(order.id);
  const responses = await Promise.all([f.pay(order.id, proof), f.pay(order.id, proof)]);
  const published = await responses[0]!.json();
  assert.equal(published.status, "published"); assert.equal(f.count(), 1);
  assert.equal((await f.store.history(published.site.slug)).length, 1);
  assert.equal((await f.app.request(`/api/v1/sites/${published.site.slug}/deploy`, { method: "POST", headers: { authorization: "Bearer operator-key" }, body: JSON.stringify({ files }) })).status, 403);
  const restarted = new ProPayments(f.config, f.store, f.verifier);
  assert.equal((await (await restarted.pay(order.id, new Request(order.paymentUrl))).json()).site.releaseId, published.site.releaseId);
  assert.equal(f.count(), 1);
  const saved = restarted.read(order.id); assert.equal(saved.files, undefined);
  assert.match((await f.app.request(`/sites/${published.site.slug}/`)).headers.get("content-type")!, /html/);
});
test("rejects a credential for another intent and freezes uncertain outcomes", async () => {
  const f = await setup(); const a = await (await f.create()).json(); const b = await (await f.create("purchase-two")).json();
  const proof = await f.proof(a.id);
  await assert.rejects(f.pay(b.id, proof), { status: 422 }); assert.equal(f.count(), 0);
  f.fail(); await assert.rejects(f.pay(a.id, proof), { status: 503 });
  await assert.rejects(f.pay(a.id, proof), { status: 409 }); assert.equal(f.count(), 1);
  assert.equal((await f.store.list()).length, 0);
});
test("recovers a paid publication without another payment and refuses expired intents", async () => {
  const f = await setup(); const order = await (await f.create()).json();
  const saved = f.pro.read(order.id); saved.status = "paid"; saved.reference = `0x${"34".repeat(32)}`;
  await writeFile(join(f.root, "pro-orders", `${order.id}.json`), JSON.stringify(saved));
  assert.equal((await (await f.pro.pay(order.id, new Request(order.paymentUrl))).json()).status, "published"); assert.equal(f.count(), 0);
  const other = await (await f.create("purchase-two")).json(); const expired = f.pro.read(other.id); expired.expiresAt = "2000-01-01T00:00:00Z";
  await writeFile(join(f.root, "pro-orders", `${other.id}.json`), JSON.stringify(expired));
  await assert.rejects(f.pro.pay(other.id, new Request(other.paymentUrl)), { status: 410 });
});

test("an active public-release pilot hides checkout, payment details, and discovery from non-host credentials", async () => {
  const f = await setup(); const order = await (await f.create()).json();
  for (const path of ["/pro", `/pro/${order.id}`, `/api/v1/pro-payments/${order.id}`, `/api/v1/pro-payments/${order.id}/pay`]) {
    for (const headers of [{}, { authorization: "Bearer invalid-key" }]) assert.equal((await f.app.request(path, { headers })).status, 404, path);
    assert.equal((await f.app.request(path, { headers: { "x-openquick-authorization": "Bearer operator-key" } })).status, path.endsWith("/pay") ? 402 : 200);
  }
  const publicSchema = await (await f.app.request("/openapi.json")).json();
  assert.equal(publicSchema.paths["/api/v1/pro-deploys"], undefined);
  const privateSchema = await (await f.app.request("/openapi.json", { headers: { authorization: "Bearer operator-key" } })).json();
  assert.ok(privateSchema.paths["/api/v1/pro-deploys"]);
  assert.equal(f.count(), 0);
});
