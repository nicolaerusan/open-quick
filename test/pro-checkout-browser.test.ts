import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { serve } from "@hono/node-server";
import { chromium } from "@playwright/test";
import { SiteStore } from "../src/store.js";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
import { ProPayments } from "../src/pro-payments.js";
import type { PublishingBridge } from "../src/commons-publishing.js";
import { PRO_SESSION_COOKIE } from "../src/pro-session.js";

test("native Pro checkout isolates its Host session from public content, stages a mainnet quote, and checks revocation", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "oq-pro-browser-")); const browser = await chromium.launch();
  const servers: ReturnType<typeof serve>[] = [];
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const bundle = await build({ entryPoints: ["src/pro-hosting-client.ts"], bundle: true, platform: "browser", format: "esm", write: false });
    const store = new SiteStore(root); await store.initialize();
    const privateStore = new SiteStore(join(root, "private")); await privateStore.initialize();
    const activations = new ActivationStore(root); await activations.initialize();
    let active = true;
    const ticket = `test-host.${"a".repeat(43)}`;
    let checkoutOrigin = "";
    const commonsServer = serve({ port: 0, hostname: "0.0.0.0", fetch: request => {
      const state = new URL(request.url).searchParams.get("state") ?? "";
      assert.match(state, /^[a-f0-9]{64}$/);
      return new Response(`<!doctype html><form id="auth" method="POST" action="${checkoutOrigin}/pro/hosting/authorize"><input name="ticket" value="${ticket}" type="hidden"><input name="state" value="${state}" type="hidden"><button>Continue</button></form><script>document.getElementById("auth").submit()</script>`, { headers: { "content-type": "text/html" } });
    } });
    servers.push(commonsServer); if (!commonsServer.listening) await new Promise(resolve => commonsServer.once("listening", resolve));
    const commonsOrigin = `http://localhost:${(commonsServer.address() as { port: number }).port}`;
    const bridge: PublishingBridge = { commonsOrigin, privateOrigins: [], verify: async value => active && value === ticket ? { actor: "commons:owner", purpose: "api", expires_at: Math.floor(Date.now() / 1000) + 300 } : null };
    let app: ReturnType<typeof createApp>;
    const server = serve({ port: 0, hostname: "0.0.0.0", fetch: request => {
      // Source-mode tests serve the compiled entry directly; deployed builds
      // load the same entry from dist through the authenticated script route.
      if (new URL(request.url).pathname === "/pro/hosting-client.js") return new Response(bundle.outputFiles[0]!.text, { headers: { "content-type": "text/javascript" } });
      return app.fetch(request);
    }, createServer: createHttpsServer, serverOptions: { key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) } });
    servers.push(server); if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const publicOrigin = `https://127.0.0.1:${port}`; checkoutOrigin = `https://checkout.localhost:${port}`;
    bridge.privateOrigins.push(`https://project.localhost:${port}`);
    const config = { root: join(root, "private"), recipient: "0x1111111111111111111111111111111111111111" as const,
      mainnetPayments: true, mainnetRecipient: "0x2222222222222222222222222222222222222222" as const,
      secret: "bf".repeat(32), baseUrl: publicOrigin, actors: [], privateHosting: true, commonsHosts: true, privateOrigins: bridge.privateOrigins };
    const payments = new ProPayments(config, privateStore);
    const options = { store, activations, adminToken: "test-admin", privatePublishing: { payments, store: privateStore, bridge, checkoutOrigin } };
    assert.throws(() => createApp({ ...options, privatePublishing: { ...options.privatePublishing, checkoutOrigin: publicOrigin } }), /own hostname/);
    assert.throws(() => createApp({ ...options, privatePublishing: { ...options.privatePublishing, checkoutOrigin: bridge.privateOrigins[0]! } }), /own hostname/);
    app = createApp(options);
    for (const path of ["/pro/hosting-client.js", "/api/v1/private-projects", "/sites/anything/", "/agent.md"]) assert.equal((await app.request(`${checkoutOrigin}${path}`)).status, 404);
    assert.equal((await app.request(`${checkoutOrigin}/pro/hosting`)).status, 303);
    assert.equal((await app.request(`${checkoutOrigin}/pro/hosting/login`, { method: "POST", headers: { origin: publicOrigin } })).status, 403);
    assert.equal((await app.request(`${checkoutOrigin}/pro/hosting/authorize`, { method: "POST", headers: { origin: commonsOrigin, "content-type": "application/x-www-form-urlencoded" }, body: `ticket=${ticket}&state=${"a".repeat(64)}` })).status, 403);
    assert.equal((await app.request(`${checkoutOrigin}/pro/hosting/session`, { method: "POST", headers: { origin: publicOrigin, "content-type": "application/x-www-form-urlencoded" }, body: `ticket=${ticket}` })).status, 404);
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } }); const page = await context.newPage();
    const failures: string[] = []; page.on("pageerror", error => failures.push(error.message));
    await page.goto(publicOrigin);
    await page.getByRole("link", { name: "OpenQuick home", exact: true }).click();
    assert.equal(page.url(), `${publicOrigin}/`);
    await page.screenshot({ path: "/tmp/openquick-home-pro.png", fullPage: true });
    await page.getByRole("link", { name: "PRO ↗", exact: true }).click();
    await page.waitForURL(`${checkoutOrigin}/pro`);
    await page.screenshot({ path: "/tmp/openquick-pro-entry.png", fullPage: true });
    await Promise.all([page.waitForURL(`${checkoutOrigin}/pro/hosting`), page.getByRole("button", { name: "Continue with Commons" }).click()]);
    await page.getByRole("heading", { name: /Publish privately/ }).waitFor();
    const cookie = (await context.cookies()).find(value => value.name === PRO_SESSION_COOKIE)!;
    assert.equal(cookie.domain, "checkout.localhost"); assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true);
    assert.equal(await page.evaluate(() => document.cookie), "");
    assert.equal((await context.cookies()).some(value => value.name === "__Host-openquick-login"), false, "Consumed login state is cleared");
    assert.equal((await context.request.post(`${checkoutOrigin}/pro/hosting/authorize`, { headers: { origin: commonsOrigin }, form: { ticket, state: "a".repeat(64) } })).status(), 403, "A callback cannot replace a session without its pending state");
    await page.getByRole("button", { name: "Use a sample project" }).click();
    await page.getByRole("button", { name: "Review Pro purchase" }).click();
    await page.getByRole("heading", { name: "My private Pro wiki" }).waitFor();
    assert.equal(payments.privateOrders().length, 1); assert.equal(payments.privateOrders()[0]!.quote.network, "tempo-mainnet");
    assert.equal(payments.privateOrders()[0]!.status, "pending");
    const orderId = payments.privateOrders()[0]!.id;
    const realPay = payments.pay;
    payments.pay = async (_id, request) => Response.json({ proof: request.headers.get("authorization") });
    try {
      const paid = await context.request.get(`${checkoutOrigin}/api/v1/private-payments/${orderId}/pay`, { headers: { authorization: "Payment test-proof" } });
      assert.equal(paid.status(), 200);
      assert.deepEqual(await paid.json(), { proof: "Payment test-proof" });
      for (const headers of [{ authorization: "Bearer invalid" }, { "x-openquick-authorization": "Bearer invalid", authorization: "Payment test-proof" }]) {
        assert.equal((await context.request.get(`${checkoutOrigin}/api/v1/private-payments/${orderId}/pay`, { headers })).status(), 404);
      }
      assert.equal((await context.request.post(`${checkoutOrigin}/api/v1/private-payments/${orderId}/pay`, { headers: { authorization: "Payment test-proof", origin: publicOrigin } })).status(), 404);
    } finally { payments.pay = realPay; }
    assert.equal(await page.getByRole("button", { name: "Add test funds" }).count(), 0);
    await page.screenshot({ path: "/tmp/openquick-native-pro-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: "/tmp/openquick-native-pro-mobile.png", fullPage: true });
    assert.deepEqual(failures, []);
    assert.equal((await context.request.post(`${checkoutOrigin}/api/v1/private-projects`, { headers: { origin: publicOrigin }, data: { name: "CSRF", files: [] } })).status(), 404);
    assert.equal((await context.request.get(`${publicOrigin}/api/v1/private-projects`, { headers: { cookie: `${PRO_SESSION_COOKIE}=${ticket}` } })).status(), 404);
    await store.deploy("attacker", [{ path: "index.html", content: Buffer.from("<!doctype html><h1>Public content</h1>").toString("base64") }], "operator");
    await page.goto(`${publicOrigin}/sites/attacker/`);
    assert.equal(await page.evaluate(async url => { try { return await (await fetch(url, { credentials: "include" })).text(); } catch { return "blocked"; } }, `${checkoutOrigin}/api/v1/private-projects`), "blocked");
    active = false;
    assert.match(await (await context.request.get(`${checkoutOrigin}/pro/hosting`)).text(), /Continue with Commons/);
    assert.equal((await context.request.get(`${checkoutOrigin}/api/v1/private-projects`)).status(), 404);
    assert.equal(payments.privateOrders()[0]!.status, "pending", "Browser test must never pay mainnet money");
    await context.close();
  } finally {
    await browser.close(); for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
  }
});
