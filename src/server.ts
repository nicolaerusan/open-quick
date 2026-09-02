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
