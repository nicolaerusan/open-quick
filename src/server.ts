import { ProPayments } from "./pro-payments.js";
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
const app = createApp({
  store,
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
