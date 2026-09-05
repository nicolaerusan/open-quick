import { randomBytes } from "node:crypto";
import type { PrivatePublishing } from "./private-publishing.js";
import { ProError } from "./pro-payments.js";
import { PRO_SESSION_COOKIE, proSessionIdentity, uniqueCookie } from "./pro-session.js";

type Grant = { ticket: string; actor: string; project: string; expires: number };
const grants = new WeakMap<PrivatePublishing, Map<string, Grant>>();
function current(publishing: PrivatePublishing) {
  let map = grants.get(publishing);
  if (!map) { map = new Map(); grants.set(publishing, map); }
  for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  return map;
}

/** Only an opaque project grant reaches the uploaded page's origin. */
export async function issueBrowserGrant(publishing: PrivatePublishing, request: Request, project: string, actor: string) {
  const identity = await proSessionIdentity(request, publishing.bridge, publishing.checkoutOrigin);
  if (identity?.handle !== actor) throw new ProError(404, "Not found");
  const order = publishing.payments.project(project, actor);
  if (!order.privateHosting?.origin || !publishing.bridge?.privateOrigins.includes(order.privateHosting.origin)) throw new ProError(404, "Not found");
  const map = current(publishing);
  if (map.size >= 1000) throw new ProError(429, "Too many viewing sessions. Try again shortly.");
  const token = randomBytes(32).toString("hex");
  map.set(token, { ticket: uniqueCookie(request, PRO_SESSION_COOKIE)!, actor, project, expires: Date.now() + 300_000 });
  return { ticket: token, action: `${order.privateHosting.origin}/private/session` };
}

export async function browserGrantIdentity(publishing: PrivatePublishing, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const grant = current(publishing).get(token);
  if (!grant) return null;
  const identity = await publishing.bridge?.verify(grant.ticket);
  if (!identity || identity.purpose !== "api" || identity.actor !== grant.actor || identity.expires_at <= Math.floor(Date.now() / 1000)) return null;
  return { actor: grant.actor, purpose: "preview" as const, project: grant.project, expires_at: Math.min(identity.expires_at, Math.floor(grant.expires / 1000)) };
}
