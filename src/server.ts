import { ProPayments } from "./pro-payments.js";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ActivationStore } from "./activation.js";
import { createApp } from "./app.js";
import { loadBootConfig } from "./boot.js";
import { createFilesystemStorage } from "./store.js";

const boot = loadBootConfig(process.env);

const store = createFilesystemStorage(boot.dataDir);
const activations = new ActivationStore(boot.dataDir);
await store.initialize();
await activations.initialize();
let privatePublishing;
if (process.env.OPENQUICK_PRIVATE_PUBLISHING === "true") {
  const root = join(boot.dataDir, "private-hosting");
  const privateStore = createFilesystemStorage(root);
  await privateStore.initialize();
  const secret = process.env.OPENQUICK_PRO_SECRET ?? "";
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw Error("Private hosting needs the persistent payment challenge secret");
  privatePublishing = { store: privateStore, payments: new ProPayments({
    root, recipient: process.env.OPENQUICK_PRO_RECIPIENT as `0x${string}`,
    secret: createHmac("sha256", Buffer.from(secret, "hex")).update("openquick-private-hosting-v1").digest("hex"),
    baseUrl: boot.baseUrl ?? "", privateHosting: true,
    actors: (process.env.OPENQUICK_PRO_ACTORS ?? "operator").split(",").map((value) => value.trim()).filter(Boolean),
  }, privateStore) };
}
const app = createApp({
  store,
  ...(privatePublishing ? { privatePublishing } : {}),
  ...(process.env.OPENQUICK_PRO_PAYMENTS === "true" ? { proPayments: new ProPayments({
    root: boot.dataDir, recipient: process.env.OPENQUICK_PRO_RECIPIENT as `0x${string}`,
    secret: process.env.OPENQUICK_PRO_SECRET ?? "", baseUrl: boot.baseUrl ?? "",
    actors: (process.env.OPENQUICK_PRO_ACTORS ?? "operator").split(",").map((value) => value.trim()),
  }, store) } : {}),
  activations,
  adminToken: boot.adminToken,
  production: boot.production,
  authBypass: boot.authBypass,
  insecureCookies: boot.insecureCookies,
  ...(boot.baseUrl ? { baseUrl: boot.baseUrl } : {}),
  ...(boot.attestation ? { attestation: boot.attestation } : {}),
});

serve({ fetch: app.fetch, port: boot.port }, (info) => {
  console.log(`OpenQuick listening on http://localhost:${info.port}`);
});
