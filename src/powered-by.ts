export const POWERED_BY_ROOT_ID = "openquick-powered-by";
export const POWERED_BY_STORAGE_KEY = "openquick-badge-dismissed";
export const POWERED_BY_OPT_OUT_META = "openquick-badge";
export const SPACE_AGENT_MD = "https://commons.diy/s/open-quick/agent.md";

const OPT_OUT_VALUES = new Set(["off", "false", "0", "no"]);

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function isHtmlContentType(contentType: string): boolean {
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "text/html" || media === "application/xhtml+xml";
}

export function badgeHeaderOptsOut(header: string | undefined): boolean {
  return (header ?? "").trim().toLowerCase() === "off";
}

export function shouldInjectBadge(html: string): boolean {
  if (html.includes(`id="${POWERED_BY_ROOT_ID}"`) || html.includes(`id='${POWERED_BY_ROOT_ID}'`)) {
    return false;
  }
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = attr(tag, "name");
    if (name?.toLowerCase() !== POWERED_BY_OPT_OUT_META) continue;
    const content = (attr(tag, "content") ?? "").trim().toLowerCase();
    if (OPT_OUT_VALUES.has(content)) return false;
  }
  return true;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function publicOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function markSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="18" height="18" aria-hidden="true" focusable="false">
  <path fill="#111111" fill-rule="evenodd" d="M15 3.2a11.3 11.3 0 1 0 7.7 19.6l2.5 2.5 1.5-1.5-2.5-2.5A11.3 11.3 0 0 0 15 3.2zm0 5.6a5.7 5.7 0 1 1 0 11.4 5.7 5.7 0 0 1 0-11.4z"/>
  <path fill="#c9ff38" d="M18.4 14.1 23.2 18h-2.5l4.2 6.6-5.3-5.2h2.3z"/>
</svg>`;
}

function poweredBySnippet(origin: string): string {
  const home = `${origin}/`;
  const agent = `${origin}/agent.md`;
  const homeAttr = escapeHtml(home);
  const agentAttr = escapeHtml(agent);
  const charterAttr = escapeHtml(SPACE_AGENT_MD);
  return `<div id="${POWERED_BY_ROOT_ID}" data-home="${homeAttr}" data-agent="${agentAttr}" data-charter="${charterAttr}">
<style>
#${POWERED_BY_ROOT_ID}{position:fixed;left:12px;bottom:12px;z-index:2147483000;font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;pointer-events:none}
#${POWERED_BY_ROOT_ID} .oq-chip,#${POWERED_BY_ROOT_ID} .oq-pop{pointer-events:auto}
#${POWERED_BY_ROOT_ID} .oq-chip{display:inline-flex;align-items:center;gap:8px;padding:7px 10px;background:#111;color:#c9ff38;border:1px solid #c9ff38;border-radius:999px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.28);animation:oq-pop .45s ease}
#${POWERED_BY_ROOT_ID} .oq-chip:focus-visible{outline:2px solid #c9ff38;outline-offset:3px}
#${POWERED_BY_ROOT_ID} .oq-label{letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
#${POWERED_BY_ROOT_ID} .oq-pop{display:none;position:absolute;left:0;bottom:calc(100% + 8px);width:min(280px,calc(100vw - 28px));padding:14px;background:#111;color:#f5f2e9;border:1px solid #c9ff38;border-radius:12px;box-shadow:0 10px 28px rgba(0,0,0,.35)}
#${POWERED_BY_ROOT_ID}.oq-open .oq-pop{display:block}
#${POWERED_BY_ROOT_ID} .oq-pop p{margin:0 0 10px;font:500 12px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;color:#f5f2e9}
#${POWERED_BY_ROOT_ID} .oq-pop a{color:#c9ff38;font-weight:700;text-decoration:underline}
#${POWERED_BY_ROOT_ID} .oq-actions{display:flex;justify-content:space-between;gap:10px;margin-top:12px}
#${POWERED_BY_ROOT_ID} .oq-dismiss{background:transparent;border:0;color:#c9ff38;font:700 11px ui-monospace,monospace;cursor:pointer;padding:0}
#${POWERED_BY_ROOT_ID} .oq-dismiss:focus-visible,#${POWERED_BY_ROOT_ID} .oq-pop a:focus-visible{outline:2px solid #c9ff38;outline-offset:2px}
@keyframes oq-pop{from{transform:translateY(8px) scale(.96);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){#${POWERED_BY_ROOT_ID} .oq-chip{animation:none}}
@media (max-width:640px){#${POWERED_BY_ROOT_ID}{left:8px;bottom:8px}#${POWERED_BY_ROOT_ID} .oq-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}#${POWERED_BY_ROOT_ID} .oq-chip{padding:6px}}
</style>
<button type="button" class="oq-chip" data-oq-chip aria-expanded="false" aria-controls="${POWERED_BY_ROOT_ID}-pop" title="Powered by OpenQuick">
${markSvg()}<span class="oq-label">Powered by OpenQuick</span>
</button>
<div class="oq-pop" id="${POWERED_BY_ROOT_ID}-pop" data-oq-pop role="dialog" aria-label="About OpenQuick" hidden>
<p>This site is hosted by OpenQuick — ship a folder, get a URL.</p>
<p><a data-oq-home href="${homeAttr}">OpenQuick home</a> · <a data-oq-agent href="${agentAttr}">agent.md</a></p>
<div class="oq-actions"><button type="button" class="oq-dismiss" data-oq-dismiss>Dismiss</button></div>
</div>
<script>
(function(){
  var root=document.getElementById(${JSON.stringify(POWERED_BY_ROOT_ID)});
  if(!root)return;
  try{if(localStorage.getItem(${JSON.stringify(POWERED_BY_STORAGE_KEY)})==="1"){root.setAttribute("hidden","");return;}}catch(e){}
  var chip=root.querySelector("[data-oq-chip]");
  var pop=root.querySelector("[data-oq-pop]");
  var dismiss=root.querySelector("[data-oq-dismiss]");
  function setOpen(open){
    root.classList.toggle("oq-open",open);
    if(pop)pop.hidden=!open;
    if(chip)chip.setAttribute("aria-expanded",open?"true":"false");
  }
  if(chip)chip.addEventListener("click",function(){setOpen(!root.classList.contains("oq-open"));});
  if(dismiss)dismiss.addEventListener("click",function(){
    try{localStorage.setItem(${JSON.stringify(POWERED_BY_STORAGE_KEY)},"1");}catch(e){}
    root.setAttribute("hidden","");
    setOpen(false);
  });
  document.addEventListener("keydown",function(event){if(event.key==="Escape")setOpen(false);});
})();
</script>
</div>`;
}

export function injectPoweredByBadge(html: string, options: { origin: string }): string {
  if (!shouldInjectBadge(html)) return html;
  const origin = publicOrigin(options.origin);
  if (!origin) return html;
  const snippet = poweredBySnippet(origin);
  const bodyClose = html.search(/<\/body>/i);
  if (bodyClose >= 0) return `${html.slice(0, bodyClose)}${snippet}${html.slice(bodyClose)}`;
  const htmlClose = html.search(/<\/html>/i);
  if (htmlClose >= 0) return `${html.slice(0, htmlClose)}${snippet}${html.slice(htmlClose)}`;
  return `${html}${snippet}`;
}

export function maybeInjectHostedHtml(
  bytes: Uint8Array,
  contentType: string,
  origin: string,
  badgeHeader: string | undefined,
): Uint8Array {
  if (!isHtmlContentType(contentType) || badgeHeaderOptsOut(badgeHeader)) return bytes;
  const html = new TextDecoder().decode(bytes);
  if (!shouldInjectBadge(html)) return bytes;
  return new TextEncoder().encode(injectPoweredByBadge(html, { origin }));
}
