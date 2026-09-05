import { Hono } from "hono";
import { ProError, ProPayments } from "./pro-payments.js";
import type { SiteStorage } from "./storage.js";
import type { PublicActor } from "./auth-gate.js";
import type { DeployFile } from "./types.js";

export type PrivatePublishing = { payments: ProPayments; store: SiteStorage };
type Env = { Variables: { actor: string } };

/** Read the actual stream: Content-Length may be absent or incorrect. */
export async function privateJson(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new ProError(422, "Expected a JSON body");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > 1_500_000) { await reader.cancel(); throw new ProError(413, "Request exceeds 1.5 MB"); }
    chunks.push(part.value);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProError(422, "Expected a JSON object");
  return value as Record<string, unknown>;
}

export function paymentOnlyRequest(request: Request) {
  const headers = new Headers(request.headers);
  // Authentication and payment are independent. Never interpret a deploy key
  // as a payment credential, or forward it into the payment verifier.
  const proof = headers.get("payment-authorization") ?? headers.get("authorization");
  headers.delete("authorization"); headers.delete("x-openquick-authorization");
  if (proof?.startsWith("Payment ")) headers.set("authorization", proof);
  return new Request(request.url, { method: "GET", headers });
}

export function privatePublishingRoutes(
  publishing: PrivatePublishing | undefined,
  authenticate: (request: Request) => Promise<PublicActor | null>,
) {
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.header("cache-control", "private, no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("x-robots-tag", "noindex, nofollow, noarchive");
    if (!publishing) return c.json({ error: "Not found" }, 404);
    const actor = await authenticate(c.req.raw);
    if (!actor || actor.scope != null || !publishing.payments.config.actors.includes(actor.handle)) return c.json({ error: "Not found" }, 404);
    c.set("actor", actor.handle);
    await next();
  });
  app.onError((error, c) => c.json({ error: error instanceof ProError ? error.message : "Private project request failed" }, error instanceof ProError ? error.status as 422 : 422));
  app.post("/api/v1/private-projects", async (c) => {
    const body = await privateJson(c.req.raw);
    return c.json(await publishing!.payments.create(c.get("actor"), c.req.header("idempotency-key") ?? "", body.files as DeployFile[], { name: body.name as string, viewers: (body.viewers ?? []) as string[] }), 201);
  });
  app.get("/api/v1/private-projects", async (c) => {
    const actor = c.get("actor");
    const projects = [];
    for (const order of publishing!.payments.privateOrders()) {
      try {
        publishing!.payments.project(order.slug, actor);
        projects.push({ ...publishing!.payments.view(order), site: await publishing!.store.site(order.slug) });
      } catch (error) { if (!(error instanceof ProError)) throw error; }
    }
    return c.json({ projects });
  });
  app.get("/api/v1/private-payments/:id", (c) => {
    const order = publishing!.payments.authorizeOrder(c.req.param("id"), c.get("actor"));
    return c.json(publishing!.payments.view(order));
  });
  app.all("/api/v1/private-payments/:id/pay", async (c) => {
    if (!["GET", "POST"].includes(c.req.method)) return c.json({ error: "Method not allowed" }, 405);
    publishing!.payments.authorizeOrder(c.req.param("id"), c.get("actor"));
    return publishing!.payments.pay(c.req.param("id"), paymentOnlyRequest(c.req.raw));
  });
  app.post("/api/v1/private-projects/:slug/deploy", async (c) => {
    const body = await privateJson(c.req.raw);
    return c.json({ site: await publishing!.payments.updateProject(c.req.param("slug"), c.get("actor"), body.files as DeployFile[]) }, 201);
  });
  app.post("/api/v1/private-projects/:slug/viewers", async (c) => {
    const body = await privateJson(c.req.raw);
    return c.json(await publishing!.payments.shareProject(c.req.param("slug"), c.get("actor"), body.viewers));
  });
  app.get("/api/v1/private-projects/:slug/releases", async (c) => {
    publishing!.payments.project(c.req.param("slug"), c.get("actor"));
    return c.json({ releases: await publishing!.store.history(c.req.param("slug")) });
  });
  app.get("/private/:slug", (c) => {
    publishing!.payments.project(c.req.param("slug"), c.get("actor"));
    return c.redirect(`/private/${encodeURIComponent(c.req.param("slug"))}/`, 307);
  });
  app.get("/private/:slug/*", async (c) => {
    const slug = c.req.param("slug");
    publishing!.payments.project(slug, c.get("actor"));
    // Authorization happens before lookup and before any conditional-cache
    // response. Private assets never inherit public immutable cache headers.
    const path = c.req.path.slice(`/private/${slug}/`.length);
    const release = /^releases\/([^/]+)\/(.*)$/.exec(path);
    try {
      const asset = release
        ? await publishing!.store.assetAtRelease(slug, release[1]!, release[2]!)
        : await publishing!.store.asset(slug, path);
      return new Response(new Uint8Array(asset.bytes), { headers: {
        "content-type": asset.contentType, "cache-control": "private, no-store",
        "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow, noarchive",
        // Browser delivery remains a restricted artifact until the isolated
        // content-origin flow is implemented and verified. No ambient cookies.
        "content-security-policy": "sandbox allow-scripts; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      } });
    } catch { return c.json({ error: "Not found" }, 404); }
  });
  return app;
}
