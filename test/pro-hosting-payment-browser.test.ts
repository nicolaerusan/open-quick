import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { serve } from "@hono/node-server";
import { chromium } from "@playwright/test";

test("the payment client calls native browser fetch without changing its receiver", { timeout: 30_000 }, async () => {
  const bundle = await build({ entryPoints: ["src/pro-hosting-payment.ts"], bundle: true, platform: "browser", format: "esm", write: false });
  let paymentRequests = 0;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/client.js") return new Response(bundle.outputFiles[0]!.text, { headers: { "content-type": "text/javascript" } });
    if (new URL(request.url).pathname.endsWith("/pay")) {
      paymentRequests++;
      // A saved receipt can be returned before another wallet approval.
      return Response.json({ status: "published", existingReceipt: true });
    }
    return new Response("<!doctype html><title>Native payment fetch test</title>", { headers: { "content-type": "text/html" } });
  } });
  if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const result = await page.evaluate(`(async () => {
      // Keep the native browser fetch intact: Node and arrow-function fetch
      // mocks do not enforce the browser's Window receiver requirement.
      const { payHostingOrder } = await import("/client.js");
      const order = { id: "a".repeat(48), status: "pending", name: "Browser purchase", amount: "0.01", amountAtomic: "10000", currency: "pathUSD",
        token: "0x20c0000000000000000000000000000000000000", network: "tempo-testnet", chainId: 42431, quoteVersion: 1, termDays: 30,
        visibility: "private", testMode: true, recipient: "0x1111111111111111111111111111111111111111" };
      const wallet = { getMppxParameters: () => ({ getClient: async () => { throw Error("An existing receipt must not ask the wallet to sign"); } }) };
      const response = await payHostingOrder(order, "0x2222222222222222222222222222222222222222", wallet);
      return response.json();
    })()`);
    assert.deepEqual(result, { status: "published", existingReceipt: true });
    assert.equal(paymentRequests, 1);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
