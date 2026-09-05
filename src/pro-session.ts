import type { PublishingBridge } from "./commons-publishing.js";

export const PRO_SESSION_COOKIE = "__Host-openquick-pro";
export const PRO_LOGIN_COOKIE = "__Host-openquick-login";

export function uniqueCookie(request: Request, name: string) {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : undefined;
}

/** A short-lived Commons ticket stays HttpOnly and is revalidated on every use. */
export async function proSessionIdentity(request: Request, bridge: PublishingBridge | undefined, publicOrigin: string | undefined) {
  if (!bridge || !publicOrigin || new URL(request.url).hostname !== new URL(publicOrigin).hostname) return null;
  const ticket = uniqueCookie(request, PRO_SESSION_COOKIE);
  if (!ticket || ticket.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  // Cookie-authenticated mutations must come from the OpenQuick checkout.
  if (!["GET", "HEAD"].includes(request.method) &&
    (request.headers.get("origin") !== publicOrigin || request.headers.get("sec-fetch-site") === "cross-site")) return null;
  const identity = await bridge.verify(ticket);
  return identity?.purpose === "api" && Number.isInteger(identity.expires_at) && identity.expires_at > Math.floor(Date.now() / 1000)
    && /^commons:[a-z0-9-]{1,64}$/.test(identity.actor) ? { handle: identity.actor } : null;
}
