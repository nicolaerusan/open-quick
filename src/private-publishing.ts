import { Hono } from "hono";
import { ProError, ProPayments } from "./pro-payments.js";
import type { SiteStorage } from "./storage.js";
import type { PublicActor } from "./auth-gate.js";
import type { DeployFile } from "./types.js";
import type { PublishingBridge } from "./commons-publishing.js";

export type PrivatePublishing = { payments: ProPayments; store: SiteStorage; bridge?: PublishingBridge };
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
    const authorization = c.req.header("x-openquick-authorization") ?? "";
    let actor: PublicActor | null;
    if (authorization.startsWith("Publishing ")) {
      const identity = await publishing.bridge?.verify(authorization.slice(11));
      actor = identity?.purpose === "api" ? { handle: identity.actor } : null;
    } else {
      actor = await authenticate(c.req.raw);
      // Only the validated Commons bridge may assert a Commons identity.
      if (actor?.handle.startsWith("commons:")) actor = null;
    }
    if (!actor || actor.scope != null || !publishing.payments.allowsActor(actor.handle)) return c.json({ error: "Not found" }, 404);
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
    const purchases = publishing!.payments.privateOrders().filter((order) => order.actor === actor).map((order) => publishing!.payments.view(order));
    return c.json({ actor, projects, purchases });
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
  app.get("/api/v1/private-projects/:slug", (c) => {
    const order = publishing!.payments.project(c.req.param("slug"), c.get("actor"));
    return c.json(publishing!.payments.view(order));
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
    return privateAssetResponse(publishing!, slug, path, new URL(c.req.url).origin);
  });
  return app;
}

export async function privateAssetResponse(publishing: PrivatePublishing, slug: string, path: string, origin: string, browserAsset = false) {
  const release = /^releases\/([^/]+)\/(.*)$/.exec(path);
  try {
    const asset = release
      ? await publishing.store.assetAtRelease(slug, release[1]!, release[2]!)
      : await publishing.store.asset(slug, path);
    const source = `${origin}/private/${slug}/`;
    return new Response(new Uint8Array(asset.bytes), { headers: {
      "content-type": asset.contentType, "cache-control": "private, no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
      "cross-origin-opener-policy": "same-origin",
      "origin-agent-cluster": "?1",
      "x-robots-tag": "noindex, nofollow, noarchive",
      // Each browser project has its own origin. The response sandbox blocks
      // popups, forms, and top-level escapes; CSP limits resources to this project.
      "content-security-policy": `sandbox allow-scripts${browserAsset ? " allow-same-origin" : ""}; default-src 'none'; script-src 'unsafe-inline' ${source}; style-src 'unsafe-inline' ${source}; img-src data: ${source}; font-src ${source}; media-src ${source}; connect-src ${browserAsset ? source : "'none'"}; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    } });
  } catch { return Response.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "private, no-store" } }); }
}

/** No public content, console, payment API, or general account cookies here. */
export function privateBrowserRoutes(publishing: PrivatePublishing) {
  const app = new Hono();
  const bridge = publishing.bridge!;
  const cookieName = (slug: string) => `__Host-oqp-${slug.slice(11)}`;
  app.use(async (c, next) => {
    c.header("cache-control", "private, no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("x-robots-tag", "noindex, nofollow, noarchive");
    await next();
  });
  app.onError((_error, c) => c.json({ error: "Not found" }, 404));
  app.post("/private/session", async (c) => {
    if (c.req.header("origin") !== bridge.commonsOrigin ||
      !c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) return c.json({ error: "Not found" }, 404);
    const reader = c.req.raw.body?.getReader(); if (!reader) return c.json({ error: "Not found" }, 404);
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > 4096) { await reader.cancel(); return c.json({ error: "Not found" }, 404); }
      chunks.push(part.value);
    }
    const ticket = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("ticket") ?? "";
    const identity = await bridge.verify(ticket);
    if (!identity || identity.purpose !== "preview" || !identity.project) return c.json({ error: "Not found" }, 404);
    const order = publishing.payments.project(identity.project, identity.actor);
    if (!order.privateHosting?.origin || new URL(order.privateHosting.origin).hostname !== new URL(c.req.url).hostname) return c.json({ error: "Not found" }, 404);
    c.header("set-cookie", `${cookieName(identity.project)}=${ticket}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.max(0, identity.expires_at - Math.floor(Date.now() / 1000))}`);
    return c.redirect(`/private/${identity.project}/`, 303);
  });
  app.get("/private/:slug/*", async (c) => {
    const slug = c.req.param("slug");
    if (!/^oq-private-[a-f0-9]{24}$/.test(slug)) return c.json({ error: "Not found" }, 404);
    const cookies = (c.req.header("cookie") ?? "").split(";").map((value) => value.trim());
    const prefix = `${cookieName(slug)}=`;
    const matches = cookies.filter((value) => value.startsWith(prefix));
    if (matches.length !== 1) return c.json({ error: "Not found" }, 404);
    const identity = await bridge.verify(matches[0]!.slice(prefix.length));
    if (!identity || identity.purpose !== "preview" || identity.project !== slug) return c.json({ error: "Not found" }, 404);
    const order = publishing.payments.project(slug, identity.actor);
    const origin = order.privateHosting?.origin;
    if (!origin || new URL(origin).hostname !== new URL(c.req.url).hostname) return c.json({ error: "Not found" }, 404);
    return privateAssetResponse(publishing, slug, c.req.path.slice(`/private/${slug}/`.length), origin, true);
  });
  app.all("*", (c) => c.json({ error: "Not found" }, 404));
  return app;
}
