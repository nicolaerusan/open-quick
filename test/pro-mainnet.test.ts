import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";
import { ProPayments } from "../src/pro-payments.js";
import { SiteStore } from "../src/store.js";
import { newQuote, validateQuote, MAINNET_CURRENCY } from "../src/pro-quote.js";
import { assertHostingOrder, assertHostingChallenge, type HostingOrder } from "../src/pro-hosting-payment.js";

test("mainnet rollout preserves legacy test quotes, payees, receipts and safe pause behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "oq-mainnet-"));
  try {
    const store = new SiteStore(root); await store.initialize();
    const config = { root, recipient: "0x1111111111111111111111111111111111111111" as const, secret: "ef".repeat(32), baseUrl: "https://openquick.test", actors: ["operator"], privateHosting: true };
    const files = [{ path: "index.html", content: Buffer.from("<h1>Private Pro</h1>").toString("base64") }];
    const old = new ProPayments(config, store);
    const original = await old.create("operator", "test-quote-before-mainnet", files, { name: "Original", viewers: [] });
    const mainConfig = { ...config, mainnetPayments: true, mainnetRecipient: "0x2222222222222222222222222222222222222222" as const };
    const main = new ProPayments(mainConfig, store);
    assert.deepEqual(main.view(main.read(original.id)), original);
    const oldChallenge = Challenge.deserialize((await main.pay(original.id, new Request(original.paymentUrl))).headers.get("www-authenticate")!);
    assert.equal(oldChallenge.request.currency, original.token); assert.equal(oldChallenge.request.recipient, config.recipient);
    assert.equal(oldChallenge.request.methodDetails?.chainId, 42431);
    const order = await main.create("operator", "mainnet-first-pro-quote", files, { name: "Real Pro", viewers: [] });
    assert.equal(order.testMode, false); assert.equal(order.currency, "USDC.e"); assert.equal(order.chainId, 4217); assert.equal(order.recipient, mainConfig.mainnetRecipient);
    assert.equal(order.amountAtomic, "10000"); assert.equal(order.termDays, 30); assert.equal(order.token, MAINNET_CURRENCY);
    const response = await main.pay(order.id, new Request(order.paymentUrl)); assert.equal(response.status, 402);
    const challenge = Challenge.deserialize(response.headers.get("www-authenticate")!);
    await assertHostingChallenge(order as HostingOrder, challenge);
    let settlements = 0;
    const paid = new ProPayments(mainConfig, store, async () => { settlements++; return { reference: `0x${"a".repeat(64)}`, receipt: "mock-receipt" }; });
    const proof = Credential.serialize({ challenge, payload: { type: "transaction", signature: "mock-verifier-only" } });
    const published = await (await paid.pay(order.id, new Request(order.paymentUrl, { headers: { authorization: proof } }))).json();
    assert.equal(published.status, "published"); assert.equal(settlements, 1);
    const paused = new ProPayments({ ...mainConfig, mainnetPayments: false }, store);
    assert.deepEqual(await (await paused.pay(order.id, new Request(order.paymentUrl))).json(), published);
    const pending = await main.create("operator", "mainnet-next-pro-quote", files, { name: "Pending", viewers: [] });
    await assert.rejects(paused.pay(pending.id, new Request(pending.paymentUrl)), /charging is paused/);
    const changed = new ProPayments({ ...mainConfig, mainnetRecipient: "0x3333333333333333333333333333333333333333" }, store);
    await assert.rejects(changed.pay(pending.id, new Request(pending.paymentUrl)), /receiving account changed/);
    assert.deepEqual(main.view(main.read(original.id)), original);
    assert.throws(() => new ProPayments({ ...config, mainnetPayments: true }, store), /own receiving address/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("network, asset and test-mode fields cannot be mixed into a payable mainnet quote", async () => {
  const quote = newQuote(true, { network: "tempo-mainnet" });
  assert.equal(validateQuote(quote, true).chainId, 4217);
  for (const change of [{ chainId: 42431 }, { currency: "pathUSD" }, { token: "0x20c0000000000000000000000000000000000000" }, { network: "tempo-testnet" }]) assert.throws(() => validateQuote({ ...quote, ...change }, true), /Unsupported/);
  const order: HostingOrder = { ...quote, quoteVersion: 1, id: "a".repeat(48), name: "Pro", amount: "0.01", recipient: "0x1111111111111111111111111111111111111111", visibility: "private", status: "pending", testMode: false };
  assert.doesNotThrow(() => assertHostingOrder(order));
  for (const change of [{ testMode: true }, { amount: "1" }, { visibility: "public" }, { chainId: 42431 }, { termDays: 7 }, { token: "0x20c0000000000000000000000000000000000000" }]) assert.throws(() => assertHostingOrder({ ...order, ...change }), /terms changed/);
});
