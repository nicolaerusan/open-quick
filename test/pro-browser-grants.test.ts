import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteStore } from "../src/store.js";
import { ActivationStore } from "../src/activation.js";
import { ProPayments } from "../src/pro-payments.js";
import { createApp } from "../src/app.js";
import { PRO_SESSION_COOKIE } from "../src/pro-session.js";
import type { PublishingBridge } from "../src/commons-publishing.js";

test("native project viewing grants cannot authorize another origin, project or API and recheck live identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "oq-browser-grants-"));
  try {
    const store = new SiteStore(root); await store.initialize();
    const privateStore = new SiteStore(join(root, "private")); await privateStore.initialize();
    const activations = new ActivationStore(root); await activations.initialize();
    const checkoutOrigin = "https://checkout.test"; const publicOrigin = "https://openquick.test";
    const ticket = `host.${"a".repeat(43)}`; let active = true; let expired = false;
    const bridge: PublishingBridge = { commonsOrigin: "https://commons.test", privateOrigins: ["https://project-one.test", "https://project-two.test"], verify: async value => value === ticket && active ? { actor: "commons:owner", purpose: "api", expires_at: Math.floor(Date.now() / 1000) + (expired ? -1 : 240) } : null };
    const payments = new ProPayments({ root: join(root, "private"), recipient: "0x1111111111111111111111111111111111111111", secret: "ad".repeat(32), baseUrl: publicOrigin, actors: [], privateHosting: true, commonsHosts: true, privateOrigins: bridge.privateOrigins }, privateStore);
    const files = [{ path: "index.html", content: Buffer.from("<h1>Private fixture</h1>").toString("base64") }];
    const created = await payments.create("commons:owner", "native-project-fixture", files, { name: "Private fixture", viewers: [] });
    // Seed a published fixture. This boundary test never invokes a payment verifier.
    const order = payments.read(created.id); order.site = await privateStore.deploy(order.slug, files, order.actor); order.status = "published"; order.privateHosting!.until = new Date(Date.now() + 86400_000).toISOString();
    await writeFile(join(root, "private", "pro-orders", `${order.id}.json`), JSON.stringify(order));
    const publishing = { payments, store: privateStore, bridge, checkoutOrigin };
    const app = createApp({ store, activations, privatePublishing: publishing });
    const headers = { cookie: `${PRO_SESSION_COOKIE}=${ticket}`, origin: checkoutOrigin };
    const path = `/api/v1/private-projects/${order.slug}/open`;
    assert.equal((await app.request(checkoutOrigin + path, { method: "POST", headers: { ...headers, origin: publicOrigin } })).status, 404);
    assert.equal((await app.request(publicOrigin + path, { method: "POST", headers })).status, 404);
    assert.equal((await app.request(checkoutOrigin + path, { method: "POST", headers: { ...headers, cookie: `${headers.cookie}; ${headers.cookie}` } })).status, 404);
    const response = await app.request(checkoutOrigin + path, { method: "POST", headers }); assert.equal(response.status, 200);
    const grant = await response.json(); assert.match(grant.ticket, /^[a-f0-9]{64}$/); assert.equal(grant.action, "https://project-one.test/private/session"); assert.notEqual(grant.ticket, ticket);
    const submit = (origin: string, token: string) => app.request(origin + "/private/session", { method: "POST", headers: { origin: checkoutOrigin, "content-type": "application/x-www-form-urlencoded" }, body: `ticket=${token}` });
    assert.equal((await submit("https://project-two.test", grant.ticket)).status, 404);
    assert.equal((await submit("https://project-one.test", ticket)).status, 404, "The general API session must never enter a private page");
    const opened = await submit("https://project-one.test", grant.ticket); assert.equal(opened.status, 303);
    const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
    const asset = `https://project-one.test/private/${order.slug}/`;
    assert.equal((await app.request(asset, { headers: { cookie } })).status, 200);
    assert.equal((await app.request(`https://project-two.test/private/${order.slug}/`, { headers: { cookie } })).status, 404);
    assert.equal((await app.request(checkoutOrigin + "/api/v1/private-projects", { headers: { cookie: `${PRO_SESSION_COOKIE}=${grant.ticket}` } })).status, 404);
    const restarted = createApp({ store, activations, privatePublishing: { ...publishing } });
    assert.equal((await restarted.request(asset, { headers: { cookie } })).status, 404, "A restart requires reopening the project, not weakening the grant");
    expired = true; assert.equal((await app.request(asset, { headers: { cookie } })).status, 404);
    expired = false; active = false; assert.equal((await app.request(asset, { headers: { cookie } })).status, 404);
    active = true; order.privateHosting!.until = new Date(Date.now() - 1000).toISOString();
    await writeFile(join(root, "private", "pro-orders", `${order.id}.json`), JSON.stringify(order));
    assert.equal((await app.request(asset, { headers: { cookie } })).status, 404);
  } finally { await rm(root, { recursive: true, force: true }); }
});
