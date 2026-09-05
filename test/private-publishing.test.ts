import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Challenge, Credential } from "mppx";
import { ProPayments, PRIVATE_HOSTING_TERM_MS, type ProVerifier } from "../src/pro-payments.js";
import { SiteStore } from "../src/store.js";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const files = [
  { path: "index.html", content: Buffer.from('<h1>Private proposal</h1><img src="image.svg">').toString("base64") },
  { path: "image.svg", content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>Private image</text></svg>').toString("base64") },
  { path: "download.txt", content: Buffer.from("Private download").toString("base64") },
];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "oq-private-test-")); roots.push(root);
  const store = new SiteStore(root); await store.initialize();
  const privateRoot = join(root, "private-hosting");
  const privateStore = new SiteStore(privateRoot); await privateStore.initialize();
  const activations = new ActivationStore(root); await activations.initialize();
  const tokens: Record<string, string> = { operator: "operator-key" };
  for (const handle of ["viewer", "outsider", "unapproved"]) {
    const a = await activations.start({ handle, privateSink: true, origin: "https://openquick.test" });
    await activations.approve(a.id, "https://openquick.test", a.approvalCode);
    tokens[handle] = (await activations.poll(a.id, a.clientSecret)).token!;
  }
  const config = { root: privateRoot, recipient: "0x1111111111111111111111111111111111111111" as const, secret: "cd".repeat(32), baseUrl: "https://openquick.test", actors: ["operator", "viewer", "outsider"], privateHosting: true };
  const real = new ProPayments(config, privateStore);
  let settlements = 0; let fail = false;
  const verifier: ProVerifier = async (order, request) => {
    if (!request.headers.get("authorization")) return real.pay(order.id, request);
    settlements++; if (fail) throw Error("Unknown settlement outcome");
    return { reference: `0x${settlements.toString(16).padStart(64, "0")}`, receipt: "test-receipt" };
  };
  const payments = new ProPayments(config, privateStore, verifier);
  const app = createApp({ store, activations, privatePublishing: { payments, store: privateStore }, adminToken: tokens.operator! });
  const auth = (actor: string) => ({ "x-openquick-authorization": `Bearer ${tokens[actor] ?? "invalid"}` });
  const create = (key = "private-purchase-one", extra: object = {}) => app.request("/api/v1/private-projects", {
    method: "POST", headers: { ...auth("operator"), "idempotency-key": key, "content-type": "application/json" },
    body: JSON.stringify({ files, name: "Client proposal", viewers: ["viewer"], ...extra }),
  });
  const pay = async (id: string) => {
    const path = `/api/v1/private-payments/${id}/pay`;
    const challenge = await app.request(path, { headers: auth("operator") });
    assert.equal(challenge.status, 402);
    const proof = Credential.serialize({ challenge: Challenge.deserialize(challenge.headers.get("www-authenticate")!), payload: { type: "transaction", signature: "mock" } });
    return app.request(path, { headers: { ...auth("operator"), authorization: proof } });
  };
  return { root, privateRoot, config, store, privateStore, activations, payments, app, auth, create, pay, verifier, count: () => settlements, fail: () => { fail = true; } };
}

test("private beta is invisible to anonymous and unapproved identities, including discovery", async () => {
  const f = await setup();
  for (const path of ["/api/v1/private-projects", "/api/v1/private-payments/" + "a".repeat(48), "/private/oq-private-" + "a".repeat(24) + "/", "/pro", "/pro/" + "a".repeat(48), "/pro-client.js"]) {
    for (const headers of [{}, f.auth("unapproved")]) assert.equal((await f.app.request(path, { headers })).status, 404, path);
  }
  const schema = await (await f.app.request("/openapi.json")).json();
  assert.equal(Object.keys(schema.paths).some((path) => /pro-|private-/.test(path)), false);
  const disabled = createApp({ store: f.store, activations: f.activations, adminToken: "operator-key" });
  assert.equal((await disabled.request("/api/v1/private-projects", { headers: f.auth("operator") })).status, 404);
});

test("validates content and initial audience before payment; changed intent cannot reuse a purchase key", async () => {
  const f = await setup();
  assert.equal((await f.create("bad-private-one", { files: [{ path: "a.txt", content: "eA==" }] })).status, 422);
  assert.equal((await f.create("bad-private-two", { viewers: ["unapproved"] })).status, 422);
  const created = await f.create(); assert.equal(created.status, 201); const order = await created.json();
  assert.equal((await (await f.create()).json()).id, order.id);
  assert.equal((await f.create("private-purchase-one", { viewers: [] })).status, 409);
  assert.equal((await f.create("private-purchase-one", { name: "Changed" })).status, 409);
  assert.equal((await f.privateStore.list()).length, 0);
  assert.equal((await f.app.request(`/api/v1/private-payments/${order.id}/pay`, { headers: f.auth("viewer") })).status, 404);
  assert.equal(f.count(), 0);
});

test("a confirmed purchase hosts private files and retries without another charge or term extension", async () => {
  const f = await setup(); const order = await (await f.create()).json();
  const response = await f.pay(order.id); assert.equal(response.status, 200); const published = await response.json();
  assert.equal(f.count(), 1); assert.equal(published.visibility, "private");
  assert.ok(Math.abs(Date.parse(published.hostingUntil) - Date.now() - PRIVATE_HOSTING_TERM_MS) < 2000);
  assert.equal((await f.store.list()).length, 0);
  const slug = published.site.slug;
  for (const path of [`/sites/${slug}/`, `/sites/${slug}/image.svg`, `/sites/${slug}/releases/${published.site.releaseId}/`, `/api/v1/sites/${slug}`, `/api/v1/sites/${slug}/releases`]) {
    assert.equal((await f.app.request(path, { headers: f.auth("operator") })).status, 404, path);
  }
  assert.doesNotMatch(await (await f.app.request("/")).text(), new RegExp(slug));
  assert.doesNotMatch(await (await f.app.request("/api/v1/sites")).text(), new RegExp(slug));
  for (const suffix of ["", "image.svg", "download.txt", `releases/${published.site.releaseId}/`, `releases/${published.site.releaseId}/image.svg`, "_openquick-release.json"]) {
    const path = `/private/${slug}/${suffix}`;
    for (const headers of [{}, f.auth("outsider")]) assert.equal((await f.app.request(path, { headers })).status, 404, path);
    const allowed = await f.app.request(path, { headers: f.auth("viewer") });
    assert.equal(allowed.status, 200, path); assert.equal(allowed.headers.get("cache-control"), "private, no-store");
    assert.match(allowed.headers.get("content-security-policy")!, /sandbox allow-scripts/);
    assert.equal(allowed.headers.get("set-cookie"), null);
  }
  const restarted = new ProPayments(f.config, f.privateStore, f.verifier);
  const retry = await (await restarted.pay(order.id, new Request(order.paymentUrl))).json();
  assert.equal(retry.site.releaseId, published.site.releaseId); assert.equal(retry.hostingUntil, published.hostingUntil); assert.equal(f.count(), 1);
});

test("only owner updates/shares; revocation and expiry apply to all releases before conditional reads", async () => {
  const f = await setup(); const order = await (await f.create()).json(); const published = await (await f.pay(order.id)).json();
  const slug = published.site.slug;
  const mutate = (action: string, actor: string, body: object) => f.app.request(`/api/v1/private-projects/${slug}/${action}`, { method: "POST", headers: { ...f.auth(actor), "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await mutate("deploy", "viewer", { files })).status, 404);
  assert.equal((await mutate("viewers", "viewer", { viewers: ["outsider"] })).status, 404);
  assert.equal((await mutate("deploy", "operator", { files: [{ path: "index.html", content: Buffer.from("<h1>Updated privately</h1>").toString("base64") }] })).status, 201);
  assert.match(await (await f.app.request(`/private/${slug}/`, { headers: f.auth("viewer") })).text(), /Updated privately/);
  assert.equal(f.count(), 1);
  assert.equal((await mutate("viewers", "operator", { viewers: [] })).status, 200);
  for (const path of [`/private/${slug}/`, `/private/${slug}/releases/${published.site.releaseId}/image.svg`, `/api/v1/private-projects/${slug}/releases`]) {
    assert.equal((await f.app.request(path, { headers: { ...f.auth("viewer"), "if-none-match": "*" } })).status, 404);
  }
  // Retrying the original purchase remains idempotent after changing its ACL.
  assert.equal((await (await f.create()).json()).id, order.id);
  const saved = f.payments.read(order.id); saved.privateHosting!.until = "2000-01-01T00:00:00Z";
  await writeFile(join(f.privateRoot, "pro-orders", `${order.id}.json`), JSON.stringify(saved));
  assert.equal((await f.app.request(`/private/${slug}/`, { headers: { ...f.auth("operator"), "if-none-match": "*" } })).status, 410);
  assert.equal((await mutate("deploy", "operator", { files })).status, 410);
});

test("unknown settlement never exposes files and refuses a second payment", async () => {
  const f = await setup(); const order = await (await f.create()).json(); f.fail();
  assert.equal((await f.pay(order.id)).status, 503);
  assert.equal((await f.app.request(`/api/v1/private-payments/${order.id}/pay`, { headers: f.auth("operator") })).status, 409);
  assert.equal(f.count(), 1); assert.equal((await f.privateStore.list()).length, 0);
});

test("persists quoted terms and honors them after new deployment defaults change", async () => {
  const f = await setup(); const original = await (await f.create()).json();
  const disk = JSON.parse(await readFile(join(f.privateRoot, "pro-orders", `${original.id}.json`), "utf8"));
  assert.deepEqual(disk.quote, { version: 1, product: "private-hosting", amountAtomic: "10000", decimals: 6,
    currency: "pathUSD", token: "0x20c0000000000000000000000000000000000000", network: "tempo-testnet", chainId: 42431, termDays: 30 });
  const restarted = new ProPayments({ ...f.config, quote: { amountAtomic: "25000", termDays: 7 } }, f.privateStore, f.verifier);
  const retried = await restarted.create("operator", "private-purchase-one", files, { name: "Client proposal", viewers: ["viewer"] });
  assert.equal(retried.id, original.id); assert.equal(retried.amount, "0.01"); assert.equal(retried.termDays, 30);
  const updated = await restarted.create("operator", "new-deployment-quote", files, { name: "New terms", viewers: [] });
  assert.equal(updated.amount, "0.025"); assert.equal(updated.termDays, 7);
  for (const [order, expectedAtomic, days] of [[original, "10000", 30], [updated, "25000", 7]] as const) {
    const response = await restarted.pay(order.id, new Request(order.paymentUrl));
    const challenge = Challenge.deserialize(response.headers.get("www-authenticate")!);
    assert.equal(challenge.request.amount, expectedAtomic); assert.equal(challenge.request.externalId, order.id);
    assert.equal(challenge.request.recipient, order.recipient);
    const proof = Credential.serialize({ challenge, payload: { type: "transaction", signature: "mock" } });
    const receipt = await (await restarted.pay(order.id, new Request(order.paymentUrl, { headers: { authorization: proof } }))).json();
    assert.equal(receipt.amountAtomic, expectedAtomic); assert.equal(receipt.termDays, days);
    assert.equal(Date.parse(receipt.hostingUntil) - Date.parse(receipt.site.createdAt), days * 86400_000);
    const again = await (await new ProPayments(f.config, f.privateStore, f.verifier).pay(order.id, new Request(order.paymentUrl))).json();
    assert.equal(again.hostingUntil, receipt.hostingUntil); assert.equal(again.amountAtomic, expectedAtomic);
  }
  assert.equal(f.count(), 2);
});

test("legacy purchases retain their original terms and persist them on the next state transition", async () => {
  const f = await setup(); const order = await (await f.create()).json();
  const path = join(f.privateRoot, "pro-orders", `${order.id}.json`);
  const legacy = JSON.parse(await readFile(path, "utf8")); delete legacy.quote;
  await writeFile(path, JSON.stringify(legacy));
  const restarted = new ProPayments({ ...f.config, quote: { amountAtomic: "50000", termDays: 3 } }, f.privateStore, f.verifier);
  assert.equal(restarted.view(restarted.read(order.id)).amount, "0.01");
  assert.equal(restarted.view(restarted.read(order.id)).termDays, 30);
  assert.equal(JSON.parse(await readFile(path, "utf8")).quote, undefined, "Reading old receipts must not rewrite them");
  const published = await (await f.pay(order.id)).json();
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.quote.amountAtomic, "10000"); assert.equal(persisted.quote.termDays, 30);
  assert.equal(persisted.reference, published.transaction);
  assert.equal(restarted.view(restarted.read(order.id)).hostingUntil, published.hostingUntil);
});

test("malformed or unsupported stored quotes never fall back to current pricing or ask for payment", async () => {
  const f = await setup(); const order = await (await f.create()).json();
  const path = join(f.privateRoot, "pro-orders", `${order.id}.json`); const stored = f.payments.read(order.id);
  for (const change of [null, { version: 2 }, { network: "tempo-mainnet" }, { chainId: 4217 },
    { token: "0x1111111111111111111111111111111111111111" }, { currency: "USDC" }, { decimals: 2 },
    { amountAtomic: "0" }, { amountAtomic: "100000001" }, { amountAtomic: "1.2" },
    { termDays: 0 }, { termDays: 366 }, { termDays: 1.5 }, { product: "public-release" }, { newTerm: true }]) {
    await writeFile(path, JSON.stringify({ ...stored, quote: change === null ? null : { ...stored.quote, ...change } }));
    await assert.rejects(f.payments.pay(order.id, new Request(order.paymentUrl)), { status: 503 });
    assert.equal(f.count(), 0); assert.equal((await f.privateStore.list()).length, 0);
  }
});
