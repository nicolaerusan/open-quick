import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";
import { serve } from "@hono/node-server";
import { chromium, expect } from "@playwright/test";
import { proHostingPage } from "../src/pro-hosting-page.js";
import { legacyQuote } from "../src/pro-quote.js";

test("checkout reveals the saved purchase, explains a matching wallet, and brings failures into view", { timeout: 30_000 }, async () => {
  const offer = { ...legacyQuote(true), amount: "0.01", recipient: "0x1111111111111111111111111111111111111111", testMode: true };
  let order: Record<string, unknown> | undefined;
  let creates = 0; let resumes = 0;
  const bundle = await build({ entryPoints: ["src/pro-hosting-client.ts"], bundle: true, platform: "browser", format: "esm", write: false,
    plugins: [{ name: "wallet-ui-fixture", setup(builder) {
      builder.onResolve({ filter: /pro-hosting-payment\.js$/ }, () => ({ path: "wallet", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const assertHostingOrder = () => {};
        export const hostingWallet = () => ({});
        export const connectHostingPayer = async (_wallet, order) => order.recipient;
        export const payHostingOrder = async () => { throw Error("Payment test failure"); };` }));
    } }] });
  const server = serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/pro/hosting-client.js") return new Response(bundle.outputFiles[0]!.text, { headers: { "content-type": "text/javascript" } });
    if (path === "/api/v1/private-projects") {
      if (request.method === "POST") {
        creates++;
        if (order) return Response.json({ error: "Private hosting is currently full" }, { status: 429 });
        const body = await request.json() as { name: string; files: unknown[]; viewers: string[] };
        order = { ...offer, id: "a".repeat(48), name: body.name, status: "pending", visibility: "private", quoteVersion: 1,
          contentHash: createHash("sha256").update(JSON.stringify(body.files)).digest("hex"), viewers: body.viewers };
        return Response.json(order, { status: 201 });
      }
      return Response.json({ actor: "commons:owner", purchases: order ? [order] : [], projects: [] });
    }
    if (path.endsWith("/resume") && request.method === "POST" && order) {
      resumes++; order.expiresAt = new Date(Date.now() + 3600_000).toISOString();
      return Response.json(order);
    }
    return new Response(proHostingPage(offer, new URL(request.url).origin), { headers: { "content-type": "text/html" } });
  } });
  if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    assert.equal(await page.getByRole("link", { name: "Open your wallet and balances ↗" }).getAttribute("href"), "https://wallet.tempo.xyz/");
    await page.getByRole("button", { name: "Use a sample project" }).click();
    await page.getByRole("button", { name: "Review Pro purchase" }).click();
    await expect(page.getByRole("status")).toContainText("Your purchase is ready");
    await expect(page.getByRole("button", { name: "Choose payment wallet" })).toBeInViewport();
    await page.getByRole("button", { name: "Choose payment wallet" }).click();
    await expect(page.getByText(/This is also OpenQuick’s receiving wallet/)).toBeVisible();
    await page.getByRole("button", { name: "Pay 0.01 test pathUSD", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Payment test failure");
    await expect(page.getByRole("alert")).toBeInViewport();
    assert.equal(order?.status, "pending");
    order!.expiresAt = "2000-01-01T00:00:00Z";
    await page.reload();
    await page.getByRole("button", { name: "Resume purchase", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Your saved purchase is ready");
    await expect(page.getByRole("button", { name: "Choose payment wallet" })).toBeInViewport();
    assert.equal(creates, 1); assert.equal(resumes, 1);
    await page.reload();
    await page.getByRole("button", { name: "Use a sample project" }).click();
    await page.getByRole("button", { name: "Review Pro purchase" }).click();
    await expect(page.getByRole("status")).toContainText("Your saved purchase is ready");
    assert.equal(creates, 1, "Review after reload must reuse the existing purchase at full capacity");
    assert.equal(resumes, 2);
  } finally {
    await browser.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
