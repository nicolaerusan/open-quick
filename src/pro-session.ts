import type { PublishingBridge } from "./commons-publishing.js";

export const PRO_SESSION_COOKIE = "__Host-openquick-pro";

/** A short-lived Commons ticket stays HttpOnly and is revalidated on every use. */
export async function proSessionIdentity(request: Request, bridge: PublishingBridge | undefined, publicOrigin: string | undefined) {
  if (!bridge || !publicOrigin || new URL(request.url).hostname !== new URL(publicOrigin).hostname) return null;
  const ticket = (request.headers.get("cookie") ?? "").split(";").map((value) => value.trim())
    .find((value) => value.startsWith(`${PRO_SESSION_COOKIE}=`))?.slice(PRO_SESSION_COOKIE.length + 1);
  if (!ticket || ticket.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  // Cookie-authenticated mutations must come from the OpenQuick checkout.
  if (!["GET", "HEAD"].includes(request.method) &&
    (request.headers.get("origin") !== publicOrigin || request.headers.get("sec-fetch-site") === "cross-site")) return null;
  const identity = await bridge.verify(ticket);
  return identity?.purpose === "api" && Number.isInteger(identity.expires_at) && identity.expires_at > Math.floor(Date.now() / 1000)
    && /^commons:[a-z0-9-]{1,64}$/.test(identity.actor) ? { handle: identity.actor } : null;
}
