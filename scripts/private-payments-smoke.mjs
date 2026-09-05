// Real Tempo testnet settlement against an ephemeral HTTP server, or a deployed
// host-only pilot. The disposable payer stays in memory and uses faucet tokens.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createPublicClient, erc20Abi, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { Mppx, tempo } from "mppx/client";
import { ProPayments } from "../dist/pro-payments.js";
import { SiteStore } from "../dist/store.js";
import { ActivationStore } from "../dist/activation.js";
import { createApp } from "../dist/app.js";

let server; let root;
let base = process.env.OPENQUICK_PRIVATE_SMOKE_URL;
let credential = process.env.OPENQUICK_PRIVATE_SMOKE_TOKEN;
const agentHandshake = process.env.OPENQUICK_PRIVATE_SMOKE_AGENT === "true";
if (agentHandshake && base) throw Error("The simulated agent approval is only allowed on an ephemeral local server");
const receiver = process.env.OPENQUICK_PRIVATE_SMOKE_RECIPIENT ?? privateKeyToAccount(generatePrivateKey()).address;
try {
  if (base) {
    if (!credential || !process.env.OPENQUICK_PRIVATE_SMOKE_RECIPIENT) throw Error("Remote smoke requires private auth and an explicitly expected recipient");
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw Error("Remote target must be an HTTPS origin");
    base = url.origin;
  } else {
    root = await mkdtemp(join(tmpdir(), "openquick-private-smoke-"));
    const store = new SiteStore(root); await store.initialize();
    const privateRoot = join(root, "private-hosting");
    const privateStore = new SiteStore(privateRoot); await privateStore.initialize();
    const activations = new ActivationStore(root); await activations.initialize();
    credential = randomBytes(32).toString("hex");
    const config = { root: privateRoot, recipient: receiver, secret: randomBytes(32).toString("hex"), baseUrl: "http://127.0.0.1", actors: agentHandshake ? ["operator", "smoke-agent"] : ["operator"], privateHosting: true };
    const app = createApp({ store, activations, adminToken: credential, privatePublishing: { store: privateStore, payments: new ProPayments(config, privateStore) } });
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    config.baseUrl = base;
  }
  if (agentHandshake) {
    const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const startedResponse = await post("/api/v1/agent-connections", { handle: "smoke-agent", privateSink: true });
    assert.equal(startedResponse.status, 201);
    const started = await startedResponse.json();
    const pending = await (await post(`/api/v1/agent-connections/${started.id}/poll`, { clientSecret: started.clientSecret })).json();
    assert.equal(pending.status, "pending"); assert.equal(pending.token, undefined);
    assert.equal((await fetch(`${base}/api/v1/private-projects`)).status, 404);
    // Simulate the human step only in this disposable local fixture. Never
    // approve a production agent connection or emit its private credentials.
    const approved = await post(`/api/v1/agent-connections/${started.id}/approve`, { approvalCode: started.approvalCode });
    assert.equal(approved.status, 200); assert.equal((await approved.json()).token, undefined);
    const poll = await post(`/api/v1/agent-connections/${started.id}/poll`, { clientSecret: started.clientSecret });
    assert.equal(poll.status, 200);
    const identity = await poll.json();
    assert.equal(identity.status, "approved"); assert.equal(identity.handle, "smoke-agent");
    assert.ok(typeof identity.token === "string" && identity.token.startsWith("oqt_"));
    credential = identity.token;
    assert.equal((await post(`/api/v1/agent-connections/${started.id}/poll`, { clientSecret: started.clientSecret })).status, 409);
    console.log("Local agent handshake passed: pending, human approval, private one-time credential delivery.");
  }
  const headers = { "x-openquick-authorization": `Bearer ${credential}`, "content-type": "application/json" };
  const rpc = createPublicClient({ chain: tempoModerato, transport: http(undefined, { timeout: 20_000, retryCount: 1 }) });
  const token = "0x20c0000000000000000000000000000000000000";
  const balance = () => rpc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [receiver] });
  const payer = privateKeyToAccount(generatePrivateKey());
  console.log("Funding a disposable Tempo testnet payer…");
  await Actions.faucet.fundSync(rpc, { account: payer.address, timeout: 30_000 });
  const before = await balance();
  const requestKey = randomUUID();
  const files = [{ path: "index.html", content: Buffer.from("<h1>Private publishing: confirmed testnet purchase</h1>").toString("base64") }, { path: "evidence.txt", content: Buffer.from("This asset also requires authorization.").toString("base64") }];
  const create = () => fetch(`${base}/api/v1/private-projects`, { method: "POST", headers: { ...headers, "idempotency-key": requestKey }, body: JSON.stringify({ name: "Private hosting end-to-end test", files, viewers: [] }) });
  const created = await create(); const order = await created.json(); assert.equal(created.status, 201, JSON.stringify(order));
  assert.equal(order.network, "tempo-testnet"); assert.equal(order.testMode, true); assert.equal(order.amount, "0.01");
  assert.equal(order.recipient.toLowerCase(), receiver.toLowerCase()); assert.equal(order.visibility, "private");
  if (agentHandshake) assert.equal(order.owner, "smoke-agent");
  assert.equal(new URL(order.paymentUrl).origin, base);
  assert.equal((await fetch(order.paymentUrl)).status, 404);
  const client = Mppx.create({ polyfill: false, methods: [tempo.charge({ account: payer, expectedChainId: tempoModerato.id, expectedRecipients: [receiver], getClient: () => rpc })], onChallenge: async (challenge, { createCredential }) => {
    assert.equal(challenge.request.amount, "10000"); assert.equal(String(challenge.request.currency).toLowerCase(), token);
    return createCredential();
  } });
  const paid = await client.fetch(order.paymentUrl, { headers }); const receipt = await paid.json();
  assert.equal(paid.status, 200, JSON.stringify(receipt)); assert.equal(receipt.status, "published"); assert.ok(paid.headers.get("payment-receipt"));
  const tx = await rpc.getTransactionReceipt({ hash: receipt.transaction }); assert.equal(tx.status, "success");
  assert.equal(await balance() - before, 10_000n);
  for (const suffix of ["", "evidence.txt"]) {
    const url = `${receipt.url}${suffix}`;
    assert.equal((await fetch(url)).status, 404);
    const allowed = await fetch(url, { headers }); assert.equal(allowed.status, 200); assert.equal(allowed.headers.get("cache-control"), "private, no-store");
    assert.equal((await fetch(`${base}/sites/${receipt.site.slug}/${suffix}`)).status, 404);
  }
  assert.doesNotMatch(await (await fetch(`${base}/api/v1/sites`)).text(), new RegExp(receipt.site.slug));
  const retry = await client.fetch(order.paymentUrl, { headers }); const repeated = await retry.json();
  assert.equal(retry.status, 200); assert.equal(repeated.transaction, receipt.transaction); assert.equal(repeated.hostingUntil, receipt.hostingUntil);
  assert.equal((await (await create()).json()).id, order.id);
  const update = await fetch(`${base}/api/v1/private-projects/${receipt.site.slug}/deploy`, { method: "POST", headers, body: JSON.stringify({ files: [{ path: "index.html", content: Buffer.from("<h1>Updated within the paid hosting term</h1>").toString("base64") }] }) });
  assert.equal(update.status, 201); assert.match(await (await fetch(receipt.url, { headers })).text(), /Updated within/);
  assert.equal(await balance() - before, 10_000n, "Retry or update charged twice");
  console.log(JSON.stringify({ result: "passed", target: root ? "ephemeral local HTTP server" : base, agentHandshake, network: "tempo-testnet", transaction: receipt.transaction, recipient: receiver, receivedAtomic: "10000", orderId: order.id, project: receipt.site.slug, hostingUntil: receipt.hostingUntil, anonymousDenied: true, assetsProtected: true, publicListingAbsent: true, updateIncluded: true, duplicatePayment: false }, null, 2));
} finally {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (root) await rm(root, { recursive: true, force: true });
}
