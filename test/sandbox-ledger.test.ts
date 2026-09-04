import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Hono } from "hono";
import { createApp } from "../src/app.js";
import { ActivationStore } from "../src/activation.js";
import { SiteStore } from "../src/store.js";
import {
  DeployPackService,
  JsonlLedger,
  PAYMENT_IDENTIFIER_EXT,
  PaymentRequiredBuilder,
  SANDBOX_AMOUNT,
  SANDBOX_ASSET,
  SANDBOX_NETWORK,
  SANDBOX_PAID_THRESHOLD,
  SANDBOX_PAY_TO,
  SANDBOX_PRODUCT_ID,
  SANDBOX_SCHEME,
  SandboxX402ExactAdapter,
  createSandboxX402App,
  generatePaymentId,
  makeSandboxService,
  registerSandboxX402Routes,
  sandboxX402Enabled,
} from "../src/sandbox-ledger.js";

const HMAC_KEY = Buffer.from("test-only-hmac-key-not-for-production-151");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpLedgerPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openquick-sandbox-"));
  roots.push(root);
  return join(root, "ledger.jsonl");
}

async function gatedService(extra: { freeQuota?: number; operatorToken?: string } = {}): Promise<DeployPackService> {
  const path = await tmpLedgerPath();
  return makeSandboxService(path, HMAC_KEY, {
    enforcePaywall: true,
    freeQuota: extra.freeQuota ?? 1,
    ...(extra.operatorToken !== undefined ? { operatorToken: extra.operatorToken } : {}),
  });
}

async function freeService(): Promise<DeployPackService> {
  const path = await tmpLedgerPath();
  return new DeployPackService({
    ledger: new JsonlLedger(path),
    provider: new SandboxX402ExactAdapter(HMAC_KEY),
    operatorToken: "op_sandbox_token",
  });
}

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: SANDBOX_SCHEME,
    network: SANDBOX_NETWORK,
    asset: SANDBOX_ASSET,
    amount: SANDBOX_AMOUNT,
    payTo: SANDBOX_PAY_TO,
    paymentIdentifier: generatePaymentId(),
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    principal: "alice",
    site: "site-a",
    productId: SANDBOX_PRODUCT_ID,
    ...overrides,
  };
}

test("default enforcePaywall is false and 5 is a meter threshold not a live gate", async () => {
  const svc = await freeService();
  assert.equal(svc.enforcePaywall, false);
  assert.equal(svc.paidThreshold, SANDBOX_PAID_THRESHOLD);
  assert.equal(svc.paidThreshold, 5);
  for (let i = 0; i < 8; i++) {
    const r = await svc.deploy({ principal: "alice", site: "site-a", deployId: `d-${i}` });
    assert.equal(r.status, 201);
    assert.equal(r.path, "free");
    assert.equal(r.billed, false);
    assert.equal(r.enforcePaywall, false);
  }
  assert.equal(svc.ledger.deployMeter("alice", "site-a"), 8);
  assert.equal(svc.ledger.balance("alice", "site-a"), 0);
});

test("402 envelope is machine-readable, credential-free, and uses public payTo", async () => {
  const svc = await gatedService();
  const env = svc.paymentRequired("alice", "site-a", { paymentIdentifier: "pay_0123456789abcdef" });
  assert.equal(env.status, 402);
  const body = env.body;
  assert.equal(body.x402Version, 2);
  assert.equal(body.productId, SANDBOX_PRODUCT_ID);
  assert.equal(body.amount, SANDBOX_AMOUNT);
  assert.equal(body.network, SANDBOX_NETWORK);
  assert.equal(body.idempotency.paymentIdentifier, "pay_0123456789abcdef");
  assert.equal(body.accepts[0]?.scheme, "exact");
  assert.equal((body.accepts[0] as { payTo: string }).payTo, SANDBOX_PAY_TO);
  assert.ok(PAYMENT_IDENTIFIER_EXT in body.extensions);
  const blob = JSON.stringify(body).toLowerCase();
  for (const banned of ["hmac", "secret", "api_key", "private_key", "credential", "op_sandbox_token"]) {
    assert.equal(blob.includes(banned), false, banned);
  }
  const decoded = new PaymentRequiredBuilder().decodeHeader(env.headers["PAYMENT-REQUIRED"]);
  assert.equal(decoded.productId, SANDBOX_PRODUCT_ID);
});

test("enforced free quota then unpaid 402", async () => {
  const svc = await gatedService();
  const first = await svc.deploy({ principal: "alice", site: "site-a" });
  assert.equal(first.status, 201);
  assert.equal(first.path, "free");
  const second = await svc.deploy({ principal: "alice", site: "site-a" });
  assert.equal(second.status, 402);
  assert.equal((second as { body: { productId: string } }).body.productId, SANDBOX_PRODUCT_ID);
  assert.ok((second as { headers: Record<string, string> }).headers["PAYMENT-REQUIRED"]);
});

test("valid settlement credits then paid deploy debits only when active", async () => {
  const svc = await gatedService();
  await svc.deploy({ principal: "alice", site: "site-a" });
  const adapter = svc.provider;
  const settled = await svc.settle(adapter.signProof(validFields()));
  assert.equal(settled.status, 200);
  assert.equal(settled.credited, true);
  assert.equal(settled.balance, 1);
  const paid = await svc.deploy({ principal: "alice", site: "site-a" });
  assert.equal(paid.status, 201);
  assert.equal(paid.path, "paid");
  assert.equal(paid.billed, true);
  assert.equal(paid.balance, 0);
});

test("client assertion without MAC is rejected", async () => {
  const svc = await gatedService();
  await svc.deploy({ principal: "alice", site: "site-a" });
  const result = await svc.settle({ ...validFields(), iPaid: true });
  assert.equal(result.status, 403);
  assert.equal(result.error, "invalid_settlement");
  assert.equal(svc.ledger.balance("alice", "site-a"), 0);
});

test("invalid, expired, wrong-recipient, and wrong-amount proofs are rejected", async () => {
  const svc = await gatedService();
  const adapter = svc.provider;

  const badMac = adapter.signProof(validFields());
  (badMac.proof as { mac: string }).mac = "00".repeat(32);
  assert.equal((await svc.settle(badMac)).status, 403);

  const expired = adapter.signProof(validFields({ expiresAt: Math.floor(Date.now() / 1000) - 10 }));
  const exp = await svc.settle(expired);
  assert.equal(exp.status, 403);
  assert.match(String(exp.detail), /expired/);

  const wrongTo = adapter.signProof(validFields({ payTo: "0x0000000000000000000000000000000000000bad" }));
  const wr = await svc.settle(wrongTo);
  assert.equal(wr.status, 403);
  assert.match(String(wr.detail), /recipient/);

  const wrongAmt = adapter.signProof(validFields({ amount: "1" }));
  const wa = await svc.settle(wrongAmt);
  assert.equal(wa.status, 403);
  assert.match(String(wa.detail), /amount/);
  assert.equal(svc.ledger.balance("alice", "site-a"), 0);
});

test("settlement replay is idempotent; different fingerprint is 409", async () => {
  const svc = await gatedService();
  const adapter = svc.provider;
  const proof = adapter.signProof(validFields());
  const first = await svc.settle(proof);
  const second = await svc.settle(proof);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.idempotentReplay, true);
  assert.equal(svc.ledger.balance("alice", "site-a"), 1);
  assert.equal(svc.ledger.readEvents().filter((e) => e.type === "credit").length, 1);

  const pid = generatePaymentId();
  const proofA = adapter.signProof(validFields({ site: "site-a", paymentIdentifier: pid }));
  const proofB = adapter.signProof(validFields({ site: "site-b", paymentIdentifier: pid }));
  assert.equal((await svc.settle(proofA)).status, 200);
  assert.equal((await svc.settle(proofB)).status, 409);
  assert.equal(svc.ledger.balance("alice", "site-b"), 0);
});

test("concurrent settlement of the same identifier credits once", async () => {
  const svc = await gatedService();
  const proof = svc.provider.signProof(validFields());
  const results = await Promise.all(Array.from({ length: 12 }, () => svc.settle(proof)));
  assert.equal(results.filter((r) => r.status === 200).length, 12);
  assert.equal(results.filter((r) => r.credited).length, 1);
  assert.equal(svc.ledger.balance("alice", "site-a"), 1);
});

test("concurrent paid deploys exhaust one pack exactly", async () => {
  const svc = await gatedService();
  await svc.deploy({ principal: "alice", site: "site-a" });
  await svc.settle(svc.provider.signProof(validFields()));
  const outcomes = await Promise.all(
    Array.from({ length: 6 }, (_, i) => svc.deploy({ principal: "alice", site: "site-a", deployId: `dpl_conc_${i}` })),
  );
  assert.equal(outcomes.filter((o) => o.status === 201 && o.path === "paid").length, 1);
  assert.equal(outcomes.filter((o) => o.status === 402).length, 5);
  assert.equal(svc.ledger.balance("alice", "site-a"), 0);
});

test("failed and partial deploys do not debit or consume quota", async () => {
  const svc = await gatedService();
  await svc.deploy({ principal: "alice", site: "site-a" });
  await svc.settle(svc.provider.signProof(validFields()));
  const failed = await svc.deploy({ principal: "alice", site: "site-a", simulate: "failed" });
  assert.equal(failed.status, 500);
  assert.equal(failed.billed, false);
  assert.equal(svc.ledger.balance("alice", "site-a"), 1);
  const partial = await svc.deploy({ principal: "alice", site: "site-a", simulate: "partial" });
  assert.equal(partial.state, "partial");
  assert.equal(partial.billed, false);
  const ok = await svc.deploy({ principal: "alice", site: "site-a", simulate: "active" });
  assert.equal(ok.status, 201);
  assert.equal(svc.ledger.balance("alice", "site-a"), 0);
});

test("paid deploy is idempotent on the same deployId", async () => {
  const svc = await gatedService();
  await svc.deploy({ principal: "alice", site: "site-a" });
  await svc.settle(svc.provider.signProof(validFields()));
  const d1 = await svc.deploy({ principal: "alice", site: "site-a", deployId: "dpl_same" });
  const d2 = await svc.deploy({ principal: "alice", site: "site-a", deployId: "dpl_same" });
  assert.equal(d1.status, 201);
  assert.equal(d2.status, 201);
  assert.equal(d2.idempotentReplay, true);
  assert.equal(svc.ledger.readEvents().filter((e) => e.type === "debit").length, 1);
});

test("credits are isolated per principal and site", async () => {
  const svc = await gatedService();
  await svc.deploy({ principal: "alice", site: "site-a" });
  await svc.deploy({ principal: "alice", site: "site-b" });
  await svc.settle(svc.provider.signProof(validFields({ site: "site-a" })));
  const a = await svc.deploy({ principal: "alice", site: "site-a" });
  const b = await svc.deploy({ principal: "alice", site: "site-b" });
  assert.equal(a.path, "paid");
  assert.equal(b.status, 402);
  await svc.deploy({ principal: "bob", site: "site-a" });
  const bobPaid = await svc.deploy({ principal: "bob", site: "site-a" });
  assert.equal(bobPaid.status, 402);
});

test("operator-token bypasses 402 and does not debit", async () => {
  const svc = await gatedService();
  await svc.deploy({ principal: "alice", site: "site-a" });
  assert.equal((await svc.deploy({ principal: "alice", site: "site-a" })).status, 402);
  const bypass = await svc.deploy({
    principal: "alice",
    site: "site-a",
    operatorToken: "op_sandbox_token",
  });
  assert.equal(bypass.status, 201);
  assert.equal(bypass.path, "operator-token");
  assert.equal(bypass.billed, false);
  const wrong = await svc.deploy({ principal: "alice", site: "site-a", operatorToken: "nope" });
  assert.equal(wrong.status, 402);
});

test("provider-down fails closed unless operator token", async () => {
  const svc = await gatedService();
  await svc.deploy({ principal: "alice", site: "site-a" });
  svc.provider.markDown();
  const r = await svc.deploy({ principal: "alice", site: "site-a" });
  assert.equal(r.status, 503);
  assert.equal(r.error, "provider_unavailable");
  const s = await svc.settle(svc.provider.signProof(validFields()));
  assert.equal(s.status, 503);
  const op = await svc.deploy({
    principal: "alice",
    site: "site-a",
    operatorToken: "op_sandbox_token",
  });
  assert.equal(op.status, 201);
  assert.equal(op.path, "operator-token");
});

test("JSONL ledger is durable across reopen", async () => {
  const path = await tmpLedgerPath();
  const svc = makeSandboxService(path, HMAC_KEY, { enforcePaywall: true });
  await svc.settle(svc.provider.signProof(validFields()));
  const raw = await readFile(path, "utf8");
  assert.match(raw, /"type":"credit"/);
  const svc2 = makeSandboxService(path, HMAC_KEY, { enforcePaywall: true });
  assert.equal(svc2.ledger.balance("alice", "site-a"), 1);
  const replay = await svc2.settle(svc.provider.signProof(validFields({
    paymentIdentifier: svc.ledger.findSettlement(String(svc.ledger.readEvents()[0]?.paymentIdentifier))?.paymentIdentifier,
  })));
  // Use the original identifier from file.
  const pid = svc2.ledger.readEvents().find((e) => e.type === "credit")?.paymentIdentifier;
  assert.ok(pid);
  const replay2 = await svc2.settle(svc.provider.signProof(validFields({ paymentIdentifier: pid })));
  assert.equal(replay2.idempotentReplay, true);
  void replay;
});

test("measures synthetic settlement latency", async () => {
  const svc = await gatedService();
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await svc.settle(svc.provider.signProof(validFields({ paymentIdentifier: generatePaymentId() })));
    assert.equal(r.status, 200);
    samples.push(Number(r.settlementLatencyMs));
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
  assert.ok(p50 < 50, `p50 ${p50}`);
  assert.ok(p95 < 100, `p95 ${p95}`);
});

test("optional GET sandbox 402 helper is off by default and not the deploy gate", async () => {
  assert.equal(sandboxX402Enabled({}), false);
  assert.equal(sandboxX402Enabled({ OPENQUICK_SANDBOX_X402: "1" }), true);
  const svc = await gatedService();
  const sandboxApp = createSandboxX402App(svc);
  const res = await sandboxApp.request("/api/v1/sandbox/x402/payment-required?principal=alice&site=site-a");
  assert.equal(res.status, 402);
  const body = await res.json() as { x402Version: number; sandbox: boolean };
  assert.equal(body.x402Version, 2);
  assert.equal(body.sandbox, true);

  const root = await mkdtemp(join(tmpdir(), "openquick-app-"));
  roots.push(root);
  const store = new SiteStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  const app = createApp({ store, activations, adminToken: "test-token", baseUrl: "https://openquick.test" });
  const missing = await app.request("/api/v1/sandbox/x402/payment-required");
  assert.equal(missing.status, 404);
  const deploy = await app.request("/api/v1/sites/hello/deploy", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ files: [{ path: "index.html", content: Buffer.from("<h1>hi</h1>").toString("base64") }] }),
  });
  assert.equal(deploy.status, 201);

  const mounted = new Hono();
  registerSandboxX402Routes(mounted, svc);
  assert.equal((await mounted.request("/api/v1/sandbox/x402/payment-required")).status, 402);
});
