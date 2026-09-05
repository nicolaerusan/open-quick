import { ProPayments, ProError } from "./pro-payments.js";
import { paymentOnlyRequest, privatePublishingRoutes, type PrivatePublishing } from "./private-publishing.js";
import { proPage } from "./pro-page.js";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import { Hono } from "hono";
import { logger } from "hono/logger";
import type { OpenQuickRelease } from "./release-attestation.js";
import type { DeployErrorCode, DeployErrorResponse, DeployPayload, RollbackPayload, SiteRecord } from "./types.js";
import { ActivationStore } from "./activation.js";
import { evaluateWriteGate, isConsoleWritePath, isWriteMethod, localRedirectPath, publicActor, scopeAllowsSlug, type PublicActor } from "./auth-gate.js";
import type { SiteStorage } from "./storage.js";
import { MAX_DEPLOY_BYTES } from "./store.js";
import { agentCard, agentMarkdown, authMarkdown, llmsTxt, openApiDocument, skillMarkdown } from "./agent-docs.js";
import { maybeInjectHostedHtml } from "./powered-by.js";

type AppOptions = {
  store: SiteStorage;
  proPayments?: ProPayments;
  privatePublishing?: PrivatePublishing;
  activations: ActivationStore;
  adminToken: string;
  production?: boolean;
  authBypass?: boolean;
  insecureCookies?: boolean;
  baseUrl?: string;
  attestation?: OpenQuickRelease;
};

function deployError(code: DeployErrorCode, error: string): DeployErrorResponse {
  return { error, code };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function landingPage(sites: Awaited<ReturnType<SiteStorage["list"]>>, baseUrl: string): string {
  const cards = sites.length === 0
    ? `<article class="empty"><span>NO DEPLOYS YET</span><h3>Your first tiny internet starts here.</h3><p>Run the deploy command from any folder containing an index.html.</p></article>`
    : sites.map((site) => `<a class="site" href="/sites/${encodeURIComponent(site.slug)}/">
        <span>LIVE / ${site.fileCount} FILE${site.fileCount === 1 ? "" : "S"}</span>
        <h3>${escapeHtml(site.slug)}</h3>
        <p>${new Date(site.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</p>
      </a>`).join("");
  const command = `Read ${baseUrl}/agent.md and follow the first-deploy workflow.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenQuick — ship the folder</title><style>
:root{color-scheme:dark;--ink:#f5f2e9;--muted:#a8a59d;--line:#343431;--lime:#c9ff38;--orange:#ff6b35;--panel:#191918}
*{box-sizing:border-box}body{margin:0;background:#0d0d0c;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(to bottom,black,transparent 72%)}
header,main,footer{position:relative;max-width:1180px;margin:auto;padding-left:28px;padding-right:28px}header{height:88px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}
.brand{display:flex;gap:12px;align-items:center;font:800 16px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.08em}.mark{width:25px;height:25px;background:var(--lime);border-radius:50% 50% 4px 50%;transform:rotate(45deg)}
.status,.nav a{font:700 11px/1 ui-monospace,monospace;color:var(--lime)}.nav{display:flex;gap:22px;align-items:center}.nav a{text-decoration:none}.hero{padding-top:92px;padding-bottom:80px}.kicker,.site span,.empty span,.agent-copy span{font:700 11px/1 ui-monospace,monospace;letter-spacing:.14em;color:var(--lime)}
h1{font-size:clamp(62px,11vw,150px);line-height:.82;letter-spacing:-.075em;margin:26px 0 38px;max-width:970px}.outline{color:transparent;-webkit-text-stroke:1px var(--muted)}
.intro{display:grid;grid-template-columns:1fr 1fr;gap:36px;align-items:end}.intro p{max-width:550px;color:var(--muted);font-size:20px;line-height:1.55;margin:0}.command{display:flex;background:var(--ink);color:#151514;padding:18px 20px;gap:16px;align-items:center;font:700 13px/1.4 ui-monospace,monospace;overflow:auto}.command b{color:#677f00}.how{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line)}
.step{padding:30px;min-height:190px;border-right:1px solid var(--line)}.step:last-child{border:0}.step em{font:800 12px/1 ui-monospace,monospace;color:var(--orange);font-style:normal}.step h2{font-size:27px;margin:42px 0 10px;letter-spacing:-.04em}.step p,.site p,.empty p{color:var(--muted);line-height:1.5;margin:0}
.agent-join{margin-top:100px;border:1px solid var(--line);background:linear-gradient(135deg,#191918,#20251a);display:grid;grid-template-columns:1.1fr .9fr}.agent-copy{padding:48px}.agent-copy h2{font-size:clamp(42px,6vw,76px);line-height:.92;letter-spacing:-.06em;margin:28px 0}.agent-copy p{color:var(--muted);font-size:18px;line-height:1.55;max-width:600px}.agent-links{border-left:1px solid var(--line);display:grid}.agent-links a{padding:24px 28px;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none;font:750 15px ui-monospace,monospace;display:flex;justify-content:space-between;align-items:center}.agent-links a:last-child{border:0}.agent-links a:hover{background:var(--lime);color:#10110d}.preview{display:inline-block;margin-top:18px;color:#111;background:var(--lime);padding:13px 16px;text-decoration:none;font:800 12px ui-monospace,monospace}
.section-head{display:flex;justify-content:space-between;align-items:end;margin:100px 0 24px}.section-head h2{font-size:45px;letter-spacing:-.05em;margin:0}.section-head span{font:700 11px ui-monospace,monospace;color:var(--muted)}
.sites{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.site,.empty{min-height:210px;padding:26px;background:var(--panel);border:1px solid var(--line);color:inherit;text-decoration:none;transition:.18s ease}.site:hover{transform:translateY(-4px);border-color:var(--lime)}.site h3,.empty h3{font-size:30px;margin:58px 0 10px;letter-spacing:-.04em}.empty{grid-column:1/-1;background:linear-gradient(120deg,#171716,#222518)}
footer{margin-top:100px;padding-top:34px;padding-bottom:60px;border-top:1px solid var(--line);display:flex;justify-content:space-between;color:var(--muted);font:700 11px ui-monospace,monospace}
@media(max-width:780px){.intro,.how,.sites,.agent-join{grid-template-columns:1fr}.agent-links{border-left:0;border-top:1px solid var(--line)}.step{border-right:0;border-bottom:1px solid var(--line)}.intro{align-items:start}.hero{padding-top:65px}h1{font-size:70px}.section-head{margin-top:70px}.status{display:none}}
</style></head><body><header><div class="brand"><span class="mark"></span>OPENQUICK</div><nav class="nav"><a href="/join">AGENT JOIN →</a><div class="status">● SYSTEM READY</div></nav></header>
<main><section class="hero"><div class="kicker">ZERO-CONFIG STATIC HOSTING / 001</div><h1>SHIP THE<br><span class="outline">FOLDER.</span></h1><div class="intro"><p>Turn a folder of HTML, CSS, and JavaScript into a live URL. No framework. No pipeline. No ceremony.</p><div class="command"><b>$</b><span>${escapeHtml(command)}</span></div></div></section>
<section class="how"><article class="step"><em>01</em><h2>Point</h2><p>Choose any folder with an index.html.</p></article><article class="step"><em>02</em><h2>Push</h2><p>The TypeScript CLI validates and uploads the release atomically.</p></article><article class="step"><em>03</em><h2>Share</h2><p>Open a durable, agent-friendly URL immediately.</p></article></section>
<section class="agent-join"><div class="agent-copy"><span>FOR SOFTWARE AGENTS / START HERE</span><h2>ONE URL.<br>ZERO GUESSING.</h2><p>Give your agent a canonical entry point with the live capability map, exact deploy steps, safety boundaries, and verification receipt.</p><a class="preview" href="/join">OPEN THE JOIN GUIDE →</a></div><div class="agent-links"><a href="/agent.md"><span>AGENT.MD</span><b>START</b></a><a href="/skill.md"><span>SKILL.MD</span><b>WORKFLOW</b></a><a href="/openapi.json"><span>OPENAPI.JSON</span><b>SCHEMA</b></a><a href="/.well-known/agent.json"><span>AGENT.JSON</span><b>DISCOVER</b></a></div></section>
<div class="section-head" id="sites"><h2>LIVE SITES</h2><span>${sites.length.toString().padStart(2,"0")} TOTAL</span></div><section class="sites">${cards}</section></main>
<footer><span>OPEN SOURCE / RAILWAY READY</span><span>KEEP IT SMALL. MAKE IT USEFUL.</span></footer></body></html>`;
}

function joinPage(baseUrl: string): string {
  const prompt = `Open ${baseUrl}/agent.md. If you can store a credential privately, POST ${baseUrl}/api/v1/agent-connections with a proposed handle and privateSink:true, ask a human to open the returned approval URL, then poll for the deploy token into your private sink. Never paste the token in chat. Deploy, verify, and return a receipt with the public handle.` ;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join OpenQuick as an agent</title><style>
:root{color-scheme:dark;--ink:#f5f2e9;--muted:#aaa79f;--line:#373733;--lime:#c9ff38;--orange:#ff6b35}*{box-sizing:border-box}body{margin:0;background:#0d0d0c;color:var(--ink);font-family:Inter,system-ui,sans-serif}main{max-width:1050px;margin:auto;padding:36px 28px 90px}nav{display:flex;justify-content:space-between;padding-bottom:28px;border-bottom:1px solid var(--line);font:800 12px ui-monospace,monospace}a{color:var(--lime)}.hero{padding:80px 0 54px}small{font:800 11px ui-monospace,monospace;color:var(--lime);letter-spacing:.13em}h1{font-size:clamp(56px,10vw,112px);line-height:.86;letter-spacing:-.07em;margin:24px 0 30px}.lead{font-size:21px;line-height:1.55;color:var(--muted);max-width:720px}.notice{border:1px solid var(--orange);padding:20px 22px;margin:32px 0;color:#ffd8ca}.grid{display:grid;grid-template-columns:repeat(2,1fr);border:1px solid var(--line)}article{padding:30px;min-height:225px;border-bottom:1px solid var(--line)}article:nth-child(odd){border-right:1px solid var(--line)}article:nth-last-child(-n+2){border-bottom:0}article b{font:800 12px ui-monospace,monospace;color:var(--orange)}h2{font-size:27px;letter-spacing:-.04em;margin:42px 0 12px}p{color:var(--muted);line-height:1.55}.prompt{margin-top:54px}.prompt pre{white-space:pre-wrap;background:var(--ink);color:#141412;padding:24px;font:700 13px/1.6 ui-monospace,monospace;overflow:auto}.resources{display:flex;flex-wrap:wrap;gap:18px;margin-top:30px;font:800 12px ui-monospace,monospace}@media(max-width:680px){.grid{grid-template-columns:1fr}article,article:nth-child(odd),article:nth-last-child(-n+2){border-right:0;border-bottom:1px solid var(--line)}article:last-child{border-bottom:0}}
</style></head><body><main><nav><a href="/">← OPENQUICK</a><span>AGENT ONBOARDING / PRIVATE PREVIEW</span></nav><section class="hero"><small>CANONICAL START / 001</small><h1>JOIN.<br>DEPLOY.<br>VERIFY.</h1><p class="lead">An agent should be able to discover what OpenQuick does, determine whether it can connect safely, complete one deploy, and prove the public result without reverse-engineering the service.</p><div class="notice"><strong>Current boundary:</strong> public discovery is live. Agents may start a browser-mediated connection: a human opens one approval URL, then a deploy credential is delivered once to the agent's private poll sink. Never paste tokens in chat.</div></section><section class="grid"><article><b>01 / DISCOVER</b><h2>Read one URL</h2><p><a href="/agent.md">agent.md</a> contains the live workflow, limits, safety rules, and machine-readable links.</p></article><article><b>02 / QUALIFY</b><h2>Check the runtime</h2><p>The agent confirms it can store a credential privately. If it cannot, it stops before requesting a secret in chat.</p></article><article><b>03 / DEPLOY</b><h2>Ship a disposable slug</h2><p>Build the TypeScript CLI, deploy a static folder, and receive a public URL plus release ID.</p></article><article><b>04 / VERIFY</b><h2>Return evidence</h2><p>Fetch the live page and report the slug, URL, release, file count, timestamp, and observed result.</p></article></section><section class="prompt"><small>COPY THIS TO AN AGENT</small><pre>${escapeHtml(prompt)}</pre><div class="resources"><a href="/llms.txt">LLMS.TXT</a><a href="/skill.md">SKILL.MD</a><a href="/auth.md">AUTH.MD</a><a href="/openapi.json">OPENAPI.JSON</a><a href="/.well-known/agent.json">AGENT.JSON</a></div></section></main></body></html>`;
}


function originOf(options: AppOptions, url: string): string {
  return options.baseUrl || new URL(url).origin;
}

function publicSiteUrls(origin: string, site: SiteRecord): { url: string; releaseUrl: string } {
  const slug = encodeURIComponent(site.slug);
  return {
    url: `${origin}/sites/${slug}/`,
    releaseUrl: `${origin}/sites/${slug}/releases/${encodeURIComponent(site.releaseId)}/`,
  };
}

function storeErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
}

/** Path-mode headers for untrusted HTML/assets on /sites/{slug}/. Host isolation is #62. */
export const HOSTED_CONTENT_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "content-security-policy": "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
} as const;

function hostedNotFound(): Response {
  return new Response("Site or asset not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=UTF-8",
      ...HOSTED_CONTENT_SECURITY_HEADERS,
    },
  });
}

function strongEtag(bytes: Uint8Array): string {
  return `"${crypto.createHash("sha256").update(bytes).digest("hex")}"`;
}

function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const tags = header.split(",").map((part) => part.trim()).filter(Boolean);
  if (tags.includes("*")) return true;
  const quoted = etag;
  const weak = etag.startsWith("W/") ? etag : `W/${etag}`;
  const strong = etag.startsWith("W/") ? etag.slice(2) : etag;
  return tags.some((tag) => tag === quoted || tag === weak || tag === strong);
}

function ifModifiedSinceFresh(header: string | undefined, mtime: Date): boolean {
  if (!header) return false;
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  return Math.floor(mtime.getTime() / 1000) <= Math.floor(since / 1000);
}

function assetResponse(
  asset: { bytes: Uint8Array; contentType: string; mtime: Date },
  cacheControl: string,
  request: { header(name: string): string | undefined },
  origin: string,
): Response {
  const bytes = maybeInjectHostedHtml(
    asset.bytes,
    asset.contentType,
    origin,
    request.header("x-openquick-badge"),
  );
  const injected = bytes !== asset.bytes;
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const etag = strongEtag(bytes);
  const lastModified = asset.mtime.toUTCString();
  const validators = {
    etag,
    "last-modified": lastModified,
    "cache-control": cacheControl,
  };
  const ifNoneMatch = request.header("if-none-match");
  const unchanged = ifNoneMatch
    ? ifNoneMatchHits(ifNoneMatch, etag)
    : !injected && ifModifiedSinceFresh(request.header("if-modified-since"), asset.mtime);
  if (unchanged) {
    return new Response(null, {
      status: 304,
      headers: { ...HOSTED_CONTENT_SECURITY_HEADERS, ...validators },
    });
  }
  return new Response(body, {
    headers: {
      "content-type": asset.contentType,
      ...HOSTED_CONTENT_SECURITY_HEADERS,
      ...validators,
    },
  });
}

function connectApprovePage(handle: string, id: string): string {
  const safeHandle = escapeHtml(handle);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve OpenQuick agent</title>
<style>body{margin:0;background:#0d0d0c;color:#f5f2e9;font-family:Inter,system-ui,sans-serif}main{max-width:640px;margin:auto;padding:48px 24px}h1{letter-spacing:-.05em}p{color:#aaa79f;line-height:1.55}button{background:#c9ff38;color:#111;border:0;padding:14px 18px;font:800 13px ui-monospace,monospace;cursor:pointer}#status{margin-top:18px;font:700 13px ui-monospace,monospace}</style>
</head><body><main><p>OPENQUICK / AGENT CONNECTION</p><h1>Approve ${safeHandle}?</h1><p>This mints a deploy credential and delivers it once to the waiting agent. The token is never shown on this page or in the URL.</p>
<form id="approve"><label>Requester code <input id="code" inputmode="numeric" pattern="[0-9]{6}" required></label><button type="submit">Approve connection</button></form><p id="status"></p>
<script>
document.getElementById("approve").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("status");
  status.textContent = "Approving…";
  const response = await fetch("/api/v1/agent-connections/${id}/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalCode: document.getElementById("code").value }) });
  const body = await response.json();
  status.textContent = response.ok ? "Approved. The agent can now poll privately." : (body.error || "Approval failed");
});
</script></main></body></html>`;
}

async function resolveBearerIdentity(options: AppOptions, authorization: string | undefined): Promise<PublicActor | null> {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return null;
  const token = authorization.slice(prefix.length);
  if (!token || token.includes("\n") || token.includes("\r")) return null;
  if (options.adminToken && token === options.adminToken) return publicActor("operator");
  const identity = await options.activations.authenticate(token);
  return identity ? publicActor(identity.handle, identity.credentialId, identity.scope) : null;
}

function writeGateOptions(options: AppOptions) {
  return {
    production: options.production === true,
    authBypass: options.authBypass === true,
    insecureCookies: options.insecureCookies === true,
  };
}

async function gateConsoleWrite(options: AppOptions, authorization: string | undefined): Promise<
  { ok: true; actor: PublicActor } | { ok: false; status: 401 | 403; body: DeployErrorResponse }
> {
  const identity = await resolveBearerIdentity(options, authorization);
  return evaluateWriteGate(writeGateOptions(options), identity);
}

type AppEnv = { Variables: { deployActor: PublicActor } };

export function createApp(options: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const requestLogger = logger();
  app.use(async (c, next) => {
    // Payment links are private capabilities; keep them out of access logs.
    if (/^\/(?:api\/v1\/(?:pro-|private-)|pro(?:\/|$)|private(?:\/|$))/.test(new URL(c.req.url).pathname)) return next();
    return requestLogger(c, next);
  });
  app.use(async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (!isConsoleWritePath(pathname) || !isWriteMethod(c.req.method)) return next();
    const gated = await gateConsoleWrite(options, c.req.header("authorization"));
    if (!gated.ok) return c.json(gated.body, gated.status);
    const slug = pathname.split("/")[4];
    if (slug && /^oq-(?:pro|private)-[a-f0-9]{24}$/.test(slug)) return c.json(deployError("scope_denied", "Use the paid project's own API"), 403);
    if (!scopeAllowsSlug(gated.actor.scope, slug)) {
      return c.json(deployError("scope_denied", "Deploy credential is not authorized for this site slug"), 403);
    }
    c.set("deployActor", gated.actor);
    return next();
  });

  const pilotIdentity = async (request: Request) => {
    const authorization = request.headers.get("x-openquick-authorization") ?? request.headers.get("authorization") ?? undefined;
    const gated = await gateConsoleWrite(options, authorization);
    return gated.ok ? gated.actor : null;
  };
  const privateRoutes = privatePublishingRoutes(options.privatePublishing, pilotIdentity);
  for (const path of ["/api/v1/private-projects", "/api/v1/private-projects/*", "/api/v1/private-payments/*", "/private/*"]) {
    app.all(path, (c) => privateRoutes.fetch(c.req.raw));
  }
  app.use(async (c, next) => {
    if (!/^\/(?:pro(?:\/|$)|pro-client\.js$|api\/v1\/pro-)/.test(c.req.path)) return next();
    c.header("cache-control", "private, no-store");
    c.header("referrer-policy", "no-referrer");
    const actor = await pilotIdentity(c.req.raw);
    if (!options.proPayments || !actor || actor.scope != null || !options.proPayments.config.actors.includes(actor.handle)) return c.json({ error: "Not found" }, 404);
    c.set("deployActor", actor);
    const id = /^\/(?:pro\/|api\/v1\/pro-payments\/)([a-f0-9]{48})(?:\/pay)?$/.exec(c.req.path)?.[1];
    if (id) {
      try { options.proPayments.authorizeOrder(id, actor.handle); }
      catch { return c.json({ error: "Not found" }, 404); }
    }
    return next();
  });
  app.get("/pro", (c) => c.html(proPage()));
  app.get("/pro/:id", (c) => c.html(proPage(c.req.param("id")), 200, { "cache-control": "no-store", "referrer-policy": "no-referrer" }));
  app.get("/pro-client.js", async (c) => c.body(await readFile(new URL("./pro-client.js", import.meta.url), "utf8"), 200, { "content-type": "text/javascript" }));
  app.use("/api/v1/pro-payments/*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });
  app.post("/api/v1/pro-deploys", async (c) => {
    c.header("cache-control", "no-store");
    if (!options.proPayments) return c.json({ error: "Pro payment pilot is disabled" }, 404);
    const actor = c.get("deployActor");
    try {
      // Bound actual streamed bytes, including chunked requests, before JSON parsing.
      const reader = c.req.raw.body?.getReader(); if (!reader) return c.json({ error: "Missing content" }, 422);
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > 1_500_000) { await reader.cancel(); return c.json({ error: "Pro request exceeds 1.5 MB" }, 413); } chunks.push(part.value); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return c.json(await options.proPayments.create(actor.handle, c.req.header("idempotency-key") ?? "", body.files), 201);
    } catch (error) { return c.json({ error: error instanceof ProError ? error.message : "Invalid Pro deployment" }, error instanceof ProError ? error.status as 422 : 422); }
  });
  app.get("/api/v1/pro-payments/:id", (c) => {
    if (!options.proPayments) return c.json({ error: "Pro payment pilot is disabled" }, 404);
    try { return c.json(options.proPayments.view(options.proPayments.read(c.req.param("id")))); }
    catch { return c.json({ error: "Intent not found" }, 404); }
  });
  app.all("/api/v1/pro-payments/:id/pay", async (c) => {
    if (!["GET", "POST"].includes(c.req.method)) return c.json({ error: "Method not allowed" }, 405);
    if (!options.proPayments) return c.json({ error: "Pro payment pilot is disabled" }, 404);
    try { return await options.proPayments.pay(c.req.param("id"), paymentOnlyRequest(c.req.raw)); }
    catch (error) { return c.json({ error: error instanceof ProError ? error.message : "Publication temporarily unavailable; retry this same intent" }, error instanceof ProError ? error.status as 422 : 503); }
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/.well-known/openquick-release.json", (c) => {
    if (!options.attestation) return c.json({ error: "Not found" }, 404);
    return c.json(options.attestation, 200, { "cache-control": "no-store" });
  });
  app.get("/llms.txt", (c) => {
    const origin = options.baseUrl || new URL(c.req.url).origin;
    return c.text(llmsTxt(origin), 200, { "content-type": "text/plain; charset=UTF-8" });
  });
  app.get("/agent.md", (c) => {
    const origin = options.baseUrl || new URL(c.req.url).origin;
    return c.text(agentMarkdown(origin), 200, { "content-type": "text/markdown; charset=UTF-8" });
  });
  app.get("/skill.md", (c) => {
    const origin = options.baseUrl || new URL(c.req.url).origin;
    return c.text(skillMarkdown(origin), 200, { "content-type": "text/markdown; charset=UTF-8" });
  });
  app.get("/auth.md", (c) => {
    const origin = options.baseUrl || new URL(c.req.url).origin;
    return c.text(authMarkdown(origin), 200, { "content-type": "text/markdown; charset=UTF-8" });
  });
  app.get("/.well-known/agent.json", (c) => {
    const origin = options.baseUrl || new URL(c.req.url).origin;
    return c.json(agentCard(origin));
  });
  app.get("/openapi.json", async (c) => {
    const origin = options.baseUrl || new URL(c.req.url).origin;
    const actor = await pilotIdentity(c.req.raw);
    const includePro = !!options.proPayments && !!actor && actor.scope == null && options.proPayments.config.actors.includes(actor.handle);
    c.header("cache-control", "private, no-store");
    return c.json(openApiDocument(origin, includePro));
  });
  app.get("/join", (c) => {
    const origin = options.baseUrl || new URL(c.req.url).origin;
    return c.html(joinPage(origin));
  });
  app.get("/api/v1/sites", async (c) => c.json({ sites: await options.store.list() }));
  app.get("/api/v1/sites/:slug", async (c) => {
    try { return c.json({ site: await options.store.site(c.req.param("slug")) }); }
    catch { return c.json({ error: "Site not found" }, 404); }
  });
  app.get("/api/v1/sites/:slug/releases", async (c) => {
    try {
      const slug = c.req.param("slug");
      const site = await options.store.site(slug);
      const releases = await options.store.history(slug);
      const origin = originOf(options, c.req.url);
      const urls = publicSiteUrls(origin, site);
      return c.json({
        site,
        url: urls.url,
        releaseUrl: urls.releaseUrl,
        fileCount: site.fileCount,
        totalBytes: site.totalBytes,
        releases,
      });
    } catch {
      return c.json({ error: "Site not found" }, 404);
    }
  });
  app.post("/api/v1/agent-connections", async (c) => {
    const origin = originOf(options, c.req.url);
    const body = await c.req.json<{ handle?: string; privateSink?: boolean; scope?: string | null }>().catch(() => ({} as { handle?: string; privateSink?: boolean; scope?: string | null }));
    try {
      const started = await options.activations.start({ handle: body.handle ?? "", privateSink: body.privateSink === true, origin, scope: body.scope ?? null });
      return c.json({
        id: started.id, handle: started.handle, status: started.status, scope: started.scope,
        approvalUrl: started.approvalUrl, pollUrl: started.pollUrl, expiresAt: started.expiresAt, clientSecret: started.clientSecret, approvalCode: started.approvalCode,
      }, 201);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
      if (code === "no_private_sink") return c.json({ error: "A private credential sink is required", code: "no_private_sink" }, 400);
      if (code === "invalid_scope") return c.json({ error: "Invalid site slug-prefix scope", code: "invalid_scope" }, 400);
      if (code === "handle_taken") return c.json({ error: "That handle is already connected", code: "handle_taken" }, 409);
      return c.json({ error: "Invalid agent handle", code: "invalid_handle" }, 400);
    }
  });
  app.get("/api/v1/agent-connections", async (c) => {
    const actor = await resolveBearerIdentity(options, c.req.header("authorization"));
    if (!actor) return c.json(deployError("unauthorized", "A valid deploy token is required"), 401);
    if (!actor.credentialId) return c.json(deployError("scope_denied", "An agent deploy credential is required"), 403);
    return c.json({ handle: actor.handle, credentials: await options.activations.listCredentials(actor.handle) });
  });
  app.delete("/api/v1/agent-connections/:id", async (c) => {
    const actor = await resolveBearerIdentity(options, c.req.header("authorization"));
    if (!actor) return c.json(deployError("unauthorized", "A valid deploy token is required"), 401);
    if (!actor.credentialId) return c.json(deployError("scope_denied", "An agent deploy credential is required"), 403);
    const revoked = await options.activations.revoke(c.req.param("id"), actor.handle);
    return revoked ? c.body(null, 204) : c.json({ error: "Credential not found" }, 404);
  });
  app.get("/connect/:id", async (c) => {
    const origin = originOf(options, c.req.url);
    const url = new URL(c.req.url);
    for (const key of ["redirect", "next", "return", "return_to", "state", "goto", "callback"]) {
      url.searchParams.delete(key);
    }
    const activation = await options.activations.publicById(c.req.param("id"), origin);
    if (!activation) return c.text("Activation not found", 404);
    if (activation.status === "expired") return c.text("This activation expired", 410);
    if (activation.status !== "pending") return c.text("This activation is no longer pending", 409);
    return c.html(connectApprovePage(activation.handle, activation.id));
  });
  app.post("/api/v1/agent-connections/:id/approve", async (c) => {
    const origin = originOf(options, c.req.url);
    const body = await c.req.json<{ approvalCode?: string }>().catch(() => ({} as { approvalCode?: string }));
    try {
      const approved = await options.activations.approve(c.req.param("id"), origin, body.approvalCode ?? "");
      return c.json({ id: approved.id, handle: approved.handle, status: approved.status, expiresAt: approved.expiresAt });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
      if (code === "expired") return c.json({ error: "Activation expired", code: "expired" }, 410);
      if (code === "replay") return c.json({ error: "Activation is no longer pending", code: "replay" }, 409);
      if (code === "invalid_code") return c.json({ error: "Invalid approval code", code: "invalid_code" }, 401);
      return c.json({ error: "Activation not found", code: "not_found" }, 404);
    }
  });
  app.post("/api/v1/agent-connections/:id/poll", async (c) => {
    const body = await c.req.json<{ clientSecret?: string }>().catch(() => ({} as { clientSecret?: string }));
    const authorization = c.req.header("authorization");
    const clientSecret = body.clientSecret
      ?? (authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "");
    try {
      const polled = await options.activations.poll(c.req.param("id"), clientSecret);
      if (polled.status === "expired") {
        return c.json({ status: "expired", error: "Activation expired", code: "expired" }, 410);
      }
      if (polled.status === "delivered") {
        return c.json({ status: "delivered", handle: polled.handle, error: "Deploy credential already delivered", code: "replay" }, 409);
      }
      const payload: Record<string, unknown> = { status: polled.status, handle: polled.handle, expiresAt: polled.expiresAt };
      if (polled.token) payload.token = polled.token;
      return c.json(payload);
    } catch {
      return c.json({ error: "A valid client secret is required", code: "unauthorized" }, 401);
    }
  });
  app.post("/api/v1/sites/:slug/deploy", async (c) => {
    const actor = c.get("deployActor") as PublicActor;
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > Math.ceil(MAX_DEPLOY_BYTES * 1.45)) {
      return c.json(deployError("payload_too_large", "Deploy request is too large"), 413);
    }
    try {
      const payload = await c.req.json<DeployPayload>();
      const site = await options.store.deploy(c.req.param("slug"), payload.files, actor.handle);
      const origin = originOf(options, c.req.url);
      return c.json({ site, ...publicSiteUrls(origin, site) }, 201);
    } catch {
      // Keep validation responses stable and safe. Store and parser errors can
      // contain user paths or provider details that must not cross the API.
      return c.json(deployError("invalid_deployment", "Deployment validation failed"), 422);
    }
  });
  app.post("/api/v1/sites/:slug/rollback", async (c) => {
    const actor = c.get("deployActor") as PublicActor;
    const payload = await c.req.json<RollbackPayload>().catch(() => ({ releaseId: "" } as RollbackPayload));
    const releaseId = typeof payload.releaseId === "string" ? payload.releaseId : "";
    try {
      const result = await options.store.rollback(c.req.param("slug"), releaseId, actor.handle);
      const origin = originOf(options, c.req.url);
      return c.json({ site: result.site, ...publicSiteUrls(origin, result.site) });
    } catch (error) {
      const code = storeErrorCode(error);
      if (code === "not_found") return c.json({ error: "Site not found" }, 404);
      if (code === "invalid_release") {
        return c.json(deployError("invalid_release", "Unknown or invalid release"), 422);
      }
      return c.json(deployError("invalid_release", "Unknown or invalid release"), 422);
    }
  });
  app.get("/sites/:slug/releases/:releaseId", (c) => {
    const slug = encodeURIComponent(c.req.param("slug"));
    const releaseId = encodeURIComponent(c.req.param("releaseId"));
    return c.redirect(localRedirectPath(`/sites/${slug}/releases/${releaseId}/`), 308);
  });
  app.get("/sites/:slug/releases/:releaseId/*", async (c) => {
    const slug = c.req.param("slug");
    const releaseId = c.req.param("releaseId");
    const prefix = `/sites/${slug}/releases/${releaseId}/`;
    const path = new URL(c.req.url).pathname.slice(prefix.length);
    try {
      const asset = await options.store.assetAtRelease(slug, releaseId, path);
      return assetResponse(asset, "public, max-age=31536000, immutable", c.req, originOf(options, c.req.url));
    } catch { return hostedNotFound(); }
  });
  app.get("/sites/:slug", (c) => c.redirect(localRedirectPath(`/sites/${encodeURIComponent(c.req.param("slug"))}/`), 308));
  app.get("/sites/:slug/*", async (c) => {
    const prefix = `/sites/${c.req.param("slug")}/`;
    const path = new URL(c.req.url).pathname.slice(prefix.length);
    try {
      const asset = await options.store.asset(c.req.param("slug"), path);
      return assetResponse(asset, asset.path === "index.html" ? "no-cache" : "public, max-age=300", c.req, originOf(options, c.req.url));
    } catch { return hostedNotFound(); }
  });
  app.get("/", async (c) => {
    const origin = options.baseUrl || new URL(c.req.url).origin;
    return c.html(landingPage(await options.store.list(), origin));
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}
