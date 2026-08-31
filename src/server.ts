import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { SiteStore } from "./store.js";

const port = Number(process.env.PORT ?? "3000");
const dataDir = process.env.DATA_DIR ?? ".data";
const adminToken = process.env.OPENQUICK_ADMIN_TOKEN ?? (process.env.NODE_ENV === "production" ? "" : "dev-token");

if (!adminToken) throw new Error("OPENQUICK_ADMIN_TOKEN is required in production");

const store = new SiteStore(dataDir);
await store.initialize();
const app = createApp({
  store,
  adminToken,
  ...(process.env.BASE_URL ? { baseUrl: process.env.BASE_URL.replace(/\/$/, "") } : {}),
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`OpenQuick listening on http://localhost:${info.port}`);
});
