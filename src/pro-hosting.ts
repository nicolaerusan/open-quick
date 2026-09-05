import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { PRO_SESSION_COOKIE, proSessionIdentity } from "./pro-session.js";
import { proHostingPage } from "./pro-hosting-page.js";
import type { PrivatePublishing } from "./private-publishing.js";

/** Native OpenQuick checkout. The Commons Host opens a five-minute session. */
export function proHostingRoutes(publishing: PrivatePublishing | undefined) {
  const app = new Hono();
  app.use(async (c, next) => {
    c.header("cache-control", "private, no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("x-robots-tag", "noindex, nofollow, noarchive");
    c.header("x-content-type-options", "nosniff");
    if (!publishing?.bridge || !publishing.checkoutOrigin) return c.json({ error: "Not found" }, 404);
    return next();
  });
  app.post("/pro/hosting/session", async (c) => {
    const bridge = publishing!.bridge!;
    if (c.req.header("origin") !== bridge.commonsOrigin || !c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) return c.json({ error: "Not found" }, 404);
    const reader = c.req.raw.body?.getReader(); if (!reader) return c.json({ error: "Not found" }, 404);
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length; if (length > 4096) { await reader.cancel(); return c.json({ error: "Not found" }, 404); }
      chunks.push(part.value);
    }
    const ticket = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("ticket") ?? "";
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket) || ticket.length > 2048) return c.json({ error: "Not found" }, 404);
    const identity = await bridge.verify(ticket);
    if (!identity || identity.purpose !== "api" || !Number.isInteger(identity.expires_at) || !/^commons:[a-z0-9-]{1,64}$/.test(identity.actor) || !publishing!.payments.allowsActor(identity.actor)) return c.json({ error: "Not found" }, 404);
    const maxAge = Math.min(300, identity.expires_at - Math.floor(Date.now() / 1000));
    if (maxAge <= 0) return c.json({ error: "Not found" }, 404);
    c.header("set-cookie", `${PRO_SESSION_COOKIE}=${ticket}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`);
    return c.redirect("/pro/hosting", 303);
  });
  app.use(async (c, next) => {
    const actor = await proSessionIdentity(c.req.raw, publishing!.bridge, publishing!.checkoutOrigin);
    if (!actor || !publishing!.payments.allowsActor(actor.handle)) return c.json({ error: "Open this checkout from the Commons Host page." }, 404);
    return next();
  });
  app.get("/pro/hosting", (c) => {
    c.header("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' https://rpc.tempo.xyz https://rpc.moderato.tempo.xyz; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    return c.html(proHostingPage(publishing!.payments.offer(), publishing!.bridge!.commonsOrigin));
  });
  app.get("/pro/hosting-client.js", async (c) => c.body(await readFile(new URL("./pro-hosting-client.js", import.meta.url), "utf8"), 200, { "content-type": "text/javascript" }));
  return app;
}
