import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { chromium } from "@playwright/test";
import { SiteStore } from "../src/store.js";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
import { ProPayments } from "../src/pro-payments.js";
import { Challenge, Credential } from "mppx";
import { commonsPublishingBridge, type PublishingBridge, type PublishingIdentity } from "../src/commons-publishing.js";

test("publishing bridge rejects cookie-sharing hostnames and untrusted remote identities", async () => {
  assert.throws(() => commonsPublishingBridge("https://commons.test", ["https://public.test:8443"], "https://public.test"), /separate hostname/);
  assert.throws(() => commonsPublishingBridge("https://commons.test", ["https://commons.test:8443"], "https://public.test"), /separate hostname/);
  const bridge = commonsPublishingBridge("http://127.0.0.1:1", ["http://localhost:2"], "http://127.0.0.1:3");
  assert.equal(await bridge.verify("login-token"), null);
  assert.equal(await bridge.verify(`a.${"b".repeat(43)}`), null);
});

test("private browser content is isolated, assets work, and access revocation bypasses caches", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "oq-browser-"));
  const browser = await chromium.launch();
  const servers: ReturnType<typeof serve>[] = [];
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "test.key"), "-out", join(root, "test.crt"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const publicStore = new SiteStore(root); await publicStore.initialize();
    const privateStore = new SiteStore(join(root, "private")); await privateStore.initialize();
    const activations = new ActivationStore(root); await activations.initialize();
    const grants = new Map<string, PublishingIdentity>();
    let active = true;
    let commonsMutations = 0;
    const commonsServer = serve({ port: 0, hostname: "0.0.0.0", fetch: (request) => {
      if (request.method === "POST") commonsMutations++;
      return new Response('<!doctype html><title>Commons host</title><h1>Host controls</h1>', { headers: { "content-type": "text/html" } });
    } }); servers.push(commonsServer);
    if (!commonsServer.listening) await new Promise((resolve) => commonsServer.once("listening", resolve));
    const commonsOrigin = `http://127.0.0.1:${(commonsServer.address() as { port: number }).port}`;
    const bridge: PublishingBridge = { commonsOrigin, privateOrigins: [], verify: async (ticket) => active ? grants.get(ticket) ?? null : null };
    const config = { root: join(root, "private"), recipient: "0x1111111111111111111111111111111111111111" as const, secret: "da".repeat(32), baseUrl: "http://127.0.0.1", actors: ["operator"], privateHosting: true, commonsHosts: true, privateOrigins: bridge.privateOrigins };
    const real = new ProPayments(config, privateStore);
    let transfers = 0;
    const payments = new ProPayments(config, privateStore, async (order, request) => {
      if (!request.headers.has("authorization")) return real.pay(order.id, request);
      return { reference: `0x${(++transfers).toString(16).padStart(64, "0")}`, receipt: "test-receipt" };
    });
    const app = createApp({ store: publicStore, activations, adminToken: "operator-key", privatePublishing: { payments, store: privateStore, bridge } });
    const observed: string[] = [];
    const server = serve({ port: 0, hostname: "0.0.0.0", fetch: (request) => {
      if (new URL(request.url).pathname.endsWith("app.js")) observed.push(JSON.stringify(Object.fromEntries(["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "origin", "referer"].map((name) => [name, request.headers.get(name)]))));
      return app.fetch(request);
    }, createServer: createHttpsServer,
      serverOptions: { key: await readFile(join(root, "test.key")), cert: await readFile(join(root, "test.crt")) } }); servers.push(server);
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const publicOrigin = `https://127.0.0.1:${port}`; bridge.privateOrigins.push(`https://project-a.localhost:${port}`, `https://project-b.localhost:${port}`);
    const publish = async (name: string, contents: Record<string, string>) => {
      const order = await payments.create("commons:owner", `test-project-${name}`, Object.entries(contents).map(([path, value]) => ({ path, content: Buffer.from(value).toString("base64") })), { name, viewers: ["commons:viewer"] });
      const url = `${publicOrigin}/api/v1/private-payments/${order.id}/pay`;
      const challenge = await payments.pay(order.id, new Request(url));
      const proof = Credential.serialize({ challenge: Challenge.deserialize(challenge.headers.get("www-authenticate")!), payload: { type: "transaction", signature: "mock" } });
      const paid = await (await payments.pay(order.id, new Request(url, { headers: { authorization: proof } }))).json();
      const ticket = `ticket-${name}`;
      grants.set(ticket, { actor: "commons:owner", purpose: "preview", project: paid.site.slug, expires_at: Math.floor(Date.now() / 1000) + 300 });
      return { slug: paid.site.slug as string, ticket, origin: paid.browserOrigin as string };
    };
    const a = await publish("first", {
      "index.html": '<!doctype html><title>Private A</title><link rel="stylesheet" href="style.css"><h1 id="title">Private A</h1><img id="image" src="image.svg"><script src="app.js"></script><script type="module" src="module.js"></script>',
      "style.css": "h1{color:rgb(1, 2, 3)}",
      "image.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
      "app.js": 'window.privateSecret="secret-A";document.body.dataset.script="loaded";',
      "module.js": 'import {prefix} from "./child.js"; const data = await (await fetch("./data.json")).json(); document.body.dataset.module = prefix + data.value;',
      "child.js": 'export const prefix = "module-";',
      "data.json": '{"value":"data"}',
    });
    const b = await publish("second", { "index.html": '<!doctype html><title>Private B</title><h1>Private B</h1>' });
    const aUrl = `${a.origin}/private/${a.slug}/`;
    const bUrl = `${b.origin}/private/${b.slug}/`;
    const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
    const browserFailures: string[] = [];
    page.on("pageerror", (error) => browserFailures.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") browserFailures.push(message.text()); });
    page.on("response", (response) => { if (response.status() >= 400) browserFailures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    const login = async ({ ticket, origin }: { ticket: string; origin: string }) => {
      await page.goto(commonsOrigin);
      await Promise.all([page.waitForURL(`${origin}/private/oq-private-*/`), page.evaluate(({ origin, ticket }) => {
        const form = document.createElement("form"); form.method = "POST"; form.action = `${origin}/private/session`;
        form.rel = "noopener";
        const input = document.createElement("input"); input.name = "ticket"; input.value = ticket; form.append(input); document.body.append(form); form.submit();
      }, { origin, ticket })]);
    };
    await login(a);
    assert.ok((await context.cookies()).some((value) => value.name.startsWith("__Host-oqp")), "Private login did not install its secure project cookie");
    const documentResponse = await context.request.get(aUrl, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
    assert.equal(documentResponse.headers()["referrer-policy"], "no-referrer");
    await page.locator('body[data-script="loaded"][data-module="module-data"]').waitFor({ timeout: 5000 }).catch((error) => { throw Error(`${error.message}\n${browserFailures.join("\n")}\n${observed.join("\n")}`); });
    assert.equal(await page.locator("#title").evaluate((el) => getComputedStyle(el).color), "rgb(1, 2, 3)");
    assert.equal(await page.locator("#image").evaluate((el) => (el as HTMLImageElement).naturalWidth), 20);
    assert.equal(await page.evaluate(async (url) => { try { await fetch(`${url}/controls`, { method: "POST", mode: "no-cors", credentials: "include", body: "mutate" }); return "sent"; } catch { return "blocked"; } }, commonsOrigin), "blocked");
    assert.equal(commonsMutations, 0, "Private JavaScript sent a mutation to Commons");
    assert.equal(await page.evaluate(() => { try { return document.cookie; } catch { return "blocked"; } }), "");
    const cookie = (await context.cookies()).find((value) => value.name.startsWith("__Host-oqp"))!;
    assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.domain, "project-a.localhost");

    // A separately paid project must not use the other project's browser login.
    await login(b);
    assert.equal(await page.evaluate((url) => { try { history.replaceState(null, "", url); return "rewritten"; } catch { return "blocked"; } }, aUrl), "blocked", "private script rewrote its origin/referrer");
    const otherRead = await page.evaluate(async (url) => { try { return await (await fetch(url, { credentials: "include" })).text(); } catch { return "blocked"; } }, aUrl);
    assert.equal(otherRead, "blocked");
    assert.equal(await page.evaluate((url) => new Promise((resolve) => { const script = document.createElement("script"); script.src = url; script.onload = () => resolve("loaded"); script.onerror = () => resolve("blocked"); document.body.append(script); }), `${aUrl}app.js`), "blocked");

    // Public hosted JavaScript has no read, script-inclusion, or mutation access.
    await publicStore.deploy("attacker", [{ path: "index.html", content: Buffer.from('<!doctype html><title>Public page</title><h1>Public page</h1>').toString("base64") }], "operator");
    await page.goto(`${publicOrigin}/sites/attacker/`);
    assert.equal(await page.evaluate(async (url) => { try { return await (await fetch(url, { credentials: "include" })).text(); } catch { return "blocked"; } }, aUrl), "blocked");
    await page.evaluate((url) => new Promise((resolve) => { const script = document.createElement("script"); script.src = url; script.onload = () => resolve("loaded"); script.onerror = () => resolve("blocked"); document.body.append(script); }), `${aUrl}app.js`);
    assert.equal(await page.evaluate(() => (window as unknown as { privateSecret?: string }).privateSecret), undefined, "public script inclusion leaked a private file");
    const mutation = await page.evaluate(async ({ base, slug }) => (await fetch(`${base}/api/v1/private-projects/${slug}/viewers`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewers: [] }) })).status, { base: publicOrigin, slug: a.slug });
    assert.equal(mutation, 404);
    assert.equal((await context.request.get(`${a.origin}/api/v1/private-projects`)).status(), 404);
    assert.equal((await context.request.get(`${a.origin}/sites/attacker/`)).status(), 404);
    assert.equal((await context.request.get(aUrl, { headers: { referer: aUrl } })).status(), 200);
    assert.equal((await context.request.get(`${b.origin}/private/${a.slug}/`)).status(), 404, "A project was served from another project's hostname");
    await assert.rejects(() => publish("over-capacity", { "index.html": "<h1>Too many</h1>" }), /at capacity/);
    grants.set("api-grant", { actor: "commons:owner", purpose: "api", expires_at: Math.floor(Date.now() / 1000) + 300 });
    assert.equal((await app.request(`${publicOrigin}/api/v1/private-projects`, { headers: { "x-openquick-authorization": "Publishing api-grant" } })).status, 200);
    assert.equal((await app.request(`${publicOrigin}/api/v1/private-projects`, { headers: { "x-openquick-authorization": `Publishing ${a.ticket}` } })).status, 404, "Read grant became management authority");
    assert.equal((await app.request(`${a.origin}/private/session`, { method: "POST", headers: { origin: publicOrigin, "content-type": "application/x-www-form-urlencoded" }, body: `ticket=${a.ticket}` })).status, 404);
    assert.equal((await app.request(`${a.origin}/private/session`, { method: "POST", headers: { origin: commonsOrigin, "content-type": "application/x-www-form-urlencoded" }, body: `ticket=api-grant` })).status, 404);
    // Viewer revocation and live Commons role loss are checked even with cookies.
    grants.set(a.ticket, { ...grants.get(a.ticket)!, actor: "commons:viewer" });
    await payments.shareProject(a.slug, "commons:owner", []);
    assert.equal((await context.request.get(aUrl, { headers: { "if-none-match": "*" } })).status(), 404);
    active = false;
    assert.equal((await context.request.get(bUrl, { headers: { "if-none-match": "*" } })).status(), 404);
    const anonymous = await browser.newContext({ ignoreHTTPSErrors: true }); assert.equal((await anonymous.request.get(aUrl)).status(), 404); await anonymous.close();
    assert.equal(transfers, 2);
    await context.close();
  } finally {
    await browser.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
  }
});
