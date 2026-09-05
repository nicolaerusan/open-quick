import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { PRO_SESSION_COOKIE, PRO_LOGIN_COOKIE, proSessionIdentity, uniqueCookie } from "./pro-session.js";
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
  app.get("/pro", async (c) => {
    const actor = await proSessionIdentity(c.req.raw, publishing!.bridge, publishing!.checkoutOrigin);
    if (actor && publishing!.payments.allowsActor(actor.handle)) return c.redirect("/pro/hosting", 303);
    // A form navigation needs its Origin preserved; no-referrer makes it null.
    // Only the origin is disclosed, never the page path or sign-in state.
    c.header("referrer-policy", "origin");
    c.header("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${publishing!.bridge!.commonsOrigin}; base-uri 'none'; frame-ancestors 'none'`);
    return c.html(proHostingPage(publishing!.payments.offer(), publishing!.payments.config.baseUrl, false));
  });
  app.post("/pro/hosting/login", (c) => {
    if (c.req.header("origin") !== publishing!.checkoutOrigin || c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "Restart sign-in from OpenQuick Pro." }, 403);
    const state = randomBytes(32).toString("hex");
    c.header("set-cookie", `${PRO_LOGIN_COOKIE}=${state}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=None`);
    return c.redirect(`${publishing!.bridge!.commonsOrigin}/openquick/authorize?state=${state}`, 303);
  });
  app.post("/pro/hosting/:operation", async (c, next) => {
    if (!["session", "authorize"].includes(c.req.param("operation"))) return next();
    const bridge = publishing!.bridge!;
    if (c.req.header("origin") !== bridge.commonsOrigin || !c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) return c.json({ error: "Not found" }, 404);
    const reader = c.req.raw.body?.getReader(); if (!reader) return c.json({ error: "Not found" }, 404);
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length; if (length > 4096) { await reader.cancel(); return c.json({ error: "Not found" }, 404); }
      chunks.push(part.value);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    if (c.req.param("operation") === "authorize") {
      const state = form.get("state") ?? "";
      if (!/^[a-f0-9]{64}$/.test(state) || uniqueCookie(c.req.raw, PRO_LOGIN_COOKIE) !== state) return c.json({ error: "Sign-in expired. Start again from OpenQuick Pro." }, 403);
      c.header("set-cookie", `${PRO_LOGIN_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None`, { append: true });
    }
    const ticket = form.get("ticket") ?? "";
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket) || ticket.length > 2048) return c.json({ error: "Not found" }, 404);
    const identity = await bridge.verify(ticket);
    if (!identity || identity.purpose !== "api" || !Number.isInteger(identity.expires_at) || !/^commons:[a-z0-9-]{1,64}$/.test(identity.actor) || !publishing!.payments.allowsActor(identity.actor)) return c.json({ error: "Not found" }, 404);
    const maxAge = Math.min(300, identity.expires_at - Math.floor(Date.now() / 1000));
    if (maxAge <= 0) return c.json({ error: "Not found" }, 404);
    c.header("set-cookie", `${PRO_SESSION_COOKIE}=${ticket}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`, { append: true });
    return c.redirect("/pro/hosting", 303);
  });
  app.use(async (c, next) => {
    const actor = await proSessionIdentity(c.req.raw, publishing!.bridge, publishing!.checkoutOrigin);
    if (!actor || !publishing!.payments.allowsActor(actor.handle)) {
      if (c.req.path === "/pro/hosting" && c.req.method === "GET") return c.redirect("/pro", 303);
      return c.json({ error: "Sign in again from OpenQuick Pro." }, 404);
    }
    return next();
  });
  app.get("/pro/hosting", (c) => {
    c.header("referrer-policy", "origin");
    c.header("content-security-policy", `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' https://rpc.tempo.xyz https://rpc.moderato.tempo.xyz; img-src data:; base-uri 'none'; form-action 'self' ${publishing!.bridge!.privateOrigins.join(" ")}; frame-ancestors 'none'; object-src 'none'`);
    return c.html(proHostingPage(publishing!.payments.offer(), publishing!.payments.config.baseUrl, true));
  });
  app.get("/pro/hosting-client.js", async (c) => c.body(await readFile(new URL("./pro-hosting-client.js", import.meta.url), "utf8"), 200, { "content-type": "text/javascript" }));
  return app;
}
