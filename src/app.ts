import { Hono } from "hono";
import { logger } from "hono/logger";
import type { DeployPayload } from "./types.js";
import { MAX_DEPLOY_BYTES, SiteStore } from "./store.js";

type AppOptions = {
  store: SiteStore;
  adminToken: string;
  baseUrl?: string;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function landingPage(sites: Awaited<ReturnType<SiteStore["list"]>>, baseUrl: string): string {
  const cards = sites.length === 0
    ? `<article class="empty"><span>NO DEPLOYS YET</span><h3>Your first tiny internet starts here.</h3><p>Run the deploy command from any folder containing an index.html.</p></article>`
    : sites.map((site) => `<a class="site" href="/sites/${encodeURIComponent(site.slug)}/">
        <span>LIVE / ${site.fileCount} FILE${site.fileCount === 1 ? "" : "S"}</span>
        <h3>${escapeHtml(site.slug)}</h3>
        <p>${new Date(site.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</p>
      </a>`).join("");
  const command = `OPENQUICK_HOST=${baseUrl} openquick deploy . --site my-site`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenQuick — ship the folder</title><style>
:root{color-scheme:dark;--ink:#f5f2e9;--muted:#a8a59d;--line:#343431;--lime:#c9ff38;--orange:#ff6b35;--panel:#191918}
*{box-sizing:border-box}body{margin:0;background:#0d0d0c;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(to bottom,black,transparent 72%)}
header,main,footer{position:relative;max-width:1180px;margin:auto;padding-left:28px;padding-right:28px}header{height:88px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}
.brand{display:flex;gap:12px;align-items:center;font:800 16px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.08em}.mark{width:25px;height:25px;background:var(--lime);border-radius:50% 50% 4px 50%;transform:rotate(45deg)}
.status{font:700 11px/1 ui-monospace,monospace;color:var(--lime)}.hero{padding-top:92px;padding-bottom:80px}.kicker,.site span,.empty span{font:700 11px/1 ui-monospace,monospace;letter-spacing:.14em;color:var(--lime)}
h1{font-size:clamp(62px,11vw,150px);line-height:.82;letter-spacing:-.075em;margin:26px 0 38px;max-width:970px}.outline{color:transparent;-webkit-text-stroke:1px var(--muted)}
.intro{display:grid;grid-template-columns:1fr 1fr;gap:36px;align-items:end}.intro p{max-width:550px;color:var(--muted);font-size:20px;line-height:1.55;margin:0}.command{display:flex;background:var(--ink);color:#151514;padding:18px 20px;gap:16px;align-items:center;font:700 13px/1.4 ui-monospace,monospace;overflow:auto}.command b{color:#677f00}.how{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line)}
.step{padding:30px;min-height:190px;border-right:1px solid var(--line)}.step:last-child{border:0}.step em{font:800 12px/1 ui-monospace,monospace;color:var(--orange);font-style:normal}.step h2{font-size:27px;margin:42px 0 10px;letter-spacing:-.04em}.step p,.site p,.empty p{color:var(--muted);line-height:1.5;margin:0}
.section-head{display:flex;justify-content:space-between;align-items:end;margin:100px 0 24px}.section-head h2{font-size:45px;letter-spacing:-.05em;margin:0}.section-head span{font:700 11px ui-monospace,monospace;color:var(--muted)}
.sites{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.site,.empty{min-height:210px;padding:26px;background:var(--panel);border:1px solid var(--line);color:inherit;text-decoration:none;transition:.18s ease}.site:hover{transform:translateY(-4px);border-color:var(--lime)}.site h3,.empty h3{font-size:30px;margin:58px 0 10px;letter-spacing:-.04em}.empty{grid-column:1/-1;background:linear-gradient(120deg,#171716,#222518)}
footer{margin-top:100px;padding-top:34px;padding-bottom:60px;border-top:1px solid var(--line);display:flex;justify-content:space-between;color:var(--muted);font:700 11px ui-monospace,monospace}
@media(max-width:780px){.intro,.how,.sites{grid-template-columns:1fr}.step{border-right:0;border-bottom:1px solid var(--line)}.intro{align-items:start}.hero{padding-top:65px}h1{font-size:70px}.section-head{margin-top:70px}.status{display:none}}
</style></head><body><header><div class="brand"><span class="mark"></span>OPENQUICK</div><div class="status">● SYSTEM READY</div></header>
<main><section class="hero"><div class="kicker">ZERO-CONFIG STATIC HOSTING / 001</div><h1>SHIP THE<br><span class="outline">FOLDER.</span></h1><div class="intro"><p>Turn a folder of HTML, CSS, and JavaScript into a live URL. No framework. No pipeline. No ceremony.</p><div class="command"><b>$</b><span>${escapeHtml(command)}</span></div></div></section>
<section class="how"><article class="step"><em>01</em><h2>Point</h2><p>Choose any folder with an index.html.</p></article><article class="step"><em>02</em><h2>Push</h2><p>The TypeScript CLI validates and uploads the release atomically.</p></article><article class="step"><em>03</em><h2>Share</h2><p>Open a durable, agent-friendly URL immediately.</p></article></section>
<div class="section-head"><h2>LIVE SITES</h2><span>${sites.length.toString().padStart(2,"0")} TOTAL</span></div><section class="sites">${cards}</section></main>
<footer><span>OPEN SOURCE / RAILWAY READY</span><span>KEEP IT SMALL. MAKE IT USEFUL.</span></footer></body></html>`;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  app.use(logger());

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/api/v1/sites", async (c) => c.json({ sites: await options.store.list() }));
  app.get("/api/v1/sites/:slug", async (c) => {
    try { return c.json({ site: await options.store.site(c.req.param("slug")) }); }
    catch { return c.json({ error: "Site not found" }, 404); }
  });
  app.post("/api/v1/sites/:slug/deploy", async (c) => {
    const authorization = c.req.header("authorization");
    if (!options.adminToken || authorization !== `Bearer ${options.adminToken}`) {
      return c.json({ error: "A valid deploy token is required" }, 401);
    }
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > Math.ceil(MAX_DEPLOY_BYTES * 1.45)) {
      return c.json({ error: "Deploy request is too large" }, 413);
    }
    try {
      const payload = await c.req.json<DeployPayload>();
      const site = await options.store.deploy(c.req.param("slug"), payload.files);
      const origin = options.baseUrl || new URL(c.req.url).origin;
      return c.json({ site, url: `${origin}/sites/${encodeURIComponent(site.slug)}/` }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid deploy" }, 422);
    }
  });
  app.get("/sites/:slug", (c) => c.redirect(`/sites/${encodeURIComponent(c.req.param("slug"))}/`, 308));
  app.get("/sites/:slug/*", async (c) => {
    const prefix = `/sites/${c.req.param("slug")}/`;
    const path = new URL(c.req.url).pathname.slice(prefix.length);
    try {
      const asset = await options.store.asset(c.req.param("slug"), path);
      const body = asset.bytes.buffer.slice(
        asset.bytes.byteOffset,
        asset.bytes.byteOffset + asset.bytes.byteLength,
      ) as ArrayBuffer;
      return new Response(body, {
        headers: {
          "content-type": asset.contentType,
          "cache-control": asset.path === "index.html" ? "no-cache" : "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    } catch { return c.text("Site or asset not found", 404); }
  });
  app.get("/", async (c) => {
    const origin = options.baseUrl || new URL(c.req.url).origin;
    return c.html(landingPage(await options.store.list(), origin));
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}
