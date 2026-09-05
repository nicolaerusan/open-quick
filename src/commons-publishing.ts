export type PublishingIdentity = { actor: string; purpose: "api" | "preview"; project?: string; expires_at: number };
export type PublishingBridge = {
  commonsOrigin: string;
  privateOrigins: string[];
  verify: (ticket: string) => Promise<PublishingIdentity | null>;
};

export function publishingOrigin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw Error("Publishing needs an HTTPS origin (or loopback HTTP)");
  return url.origin;
}

/** The fixed Commons endpoint validates the signature and live role/session. */
export function commonsPublishingBridge(commonsUrl: string, privateUrls: string[], publicUrl: string): PublishingBridge {
  const commonsOrigin = publishingOrigin(commonsUrl);
  const privateOrigins = privateUrls.map(publishingOrigin);
  if (!privateOrigins.length || privateOrigins.length > 16 || new Set(privateOrigins.map((origin) => new URL(origin).hostname)).size !== privateOrigins.length) throw Error("Configure 1–16 distinct project hostnames");
  // A different port is not sufficient cookie isolation.
  if (privateOrigins.some((privateOrigin) => [commonsOrigin, publishingOrigin(publicUrl)].some((origin) => new URL(origin).hostname === new URL(privateOrigin).hostname))) throw Error("Private content needs a separate hostname");
  return { commonsOrigin, privateOrigins, verify: async (ticket) => {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket) || ticket.length > 2048) return null;
    try {
      const result = await fetch(`${commonsOrigin}/v0/spaces/open-quick/payments/publishing/verify`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }),
        redirect: "error", signal: AbortSignal.timeout(5000), cache: "no-store",
      });
      if (!result.ok) return null;
      const identity = await result.json() as PublishingIdentity;
      if (!/^commons:[a-z0-9-]{1,64}$/.test(identity.actor) || !["api", "preview"].includes(identity.purpose) ||
        !Number.isInteger(identity.expires_at) || identity.expires_at <= Math.floor(Date.now() / 1000) ||
        identity.expires_at > Math.floor(Date.now() / 1000) + 300 ||
        (identity.purpose === "preview" && !/^oq-private-[a-f0-9]{24}$/.test(identity.project ?? ""))) return null;
      return identity;
    } catch { return null; }
  } };
}
