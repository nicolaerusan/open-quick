// Render the current UI for review without exposing credentials or accepting payments.
// Run after npm run build. Only this generated folder is suitable for preview upload.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { landingPage, joinPage } from "../dist/pages.js";
import { proHostingPage } from "../dist/pro-hosting-page.js";
import { newQuote } from "../dist/pro-quote.js";

const host = "https://open-quick-production.up.railway.app";
const output = resolve(process.argv[2] ?? "../openquick-design-preview");
const response = await fetch(`${host}/api/v1/sites`);
if (!response.ok) throw Error(`Could not read public site list: ${response.status}`);
const { sites } = await response.json();
// Terms and public receiving address observed on the live Pro entry September 8.
const offer = { ...newQuote(true, {network:"tempo-mainnet"}), amount:"0.01", testMode:false,
  recipient:"0x365069f169164f3536efd23b234b4f99a33bfdc9" };
const pages = { "": landingPage(sites, host, true), join: joinPage(host), pro: proHostingPage(offer, host, false) };
for (const [route, source] of Object.entries(pages)) {
  const depth = route ? "../" : "./";
  let html = source.replaceAll(`href="${host}"`, `href="${depth}"`);
  html = html.replace(/href="(\/[^" ]*)"/g, (_, path) => {
    if (path === "/") return `href="${depth}"`;
    if (path === "/join" || path === "/pro") return `href="${depth}${path.slice(1)}/"`;
    return `href="${host}${path}"`;
  });
  html = html.replace(/<form method="POST" action="\/pro\/hosting\/login">.*?<\/form>/s,
    `<a class="button primary" href="${host}/pro">Open live Pro sign-in ↗</a>`);
  const note = `<div class="design-review" style="padding:8px 20px;border-bottom:1px solid #e6e7e9;background:#f4f6fb;font:13px/1.5 system-ui;text-align:center;color:#454b5a;position:relative;z-index:3">Design preview · <a href="${depth}">Home</a> · <a href="${depth}join/">Guide</a> · <a href="${depth}pro/">Pro</a> · <a href="${host}/">Current product ↗</a></div>`;
  html = html.replace("<body>", `<body>${note}`).replace("</title>", " · Design preview</title>");
  if (html.includes('<form') || /localhost|127\.0\.0\.1/.test(html)) throw Error("Preview contains an unexpected form or local address");
  const dir = resolve(output, route); await mkdir(dir, {recursive:true});
  await writeFile(resolve(dir, "index.html"), html);
}
console.log(JSON.stringify({output,pages:Object.keys(pages).length,sites:sites.length,payments:"none"}));
