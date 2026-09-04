import type { DeployErrorResponse } from "./types.js";

export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const INSECURE_MODE_ERROR = "Production refuses writes while a local auth bypass or insecure cookie mode is enabled";

export type PublicActor = {
  handle: string;
  credentialId?: string;
  scope?: string | null;
};

export type WriteGateOptions = {
  production: boolean;
  authBypass: boolean;
  insecureCookies: boolean;
};

export type WriteGateResult =
  | { ok: true; actor: PublicActor }
  | { ok: false; status: 401 | 403; body: DeployErrorResponse };

export function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isConsoleWritePath(pathname: string): boolean {
  return pathname === "/api/v1/sites" || pathname.startsWith("/api/v1/sites/");
}

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/** Public attribution only: handle/id. Never email, sessions, or provider tokens. */
export function publicActor(handle: string, credentialId?: string, scope?: string | null): PublicActor {
  return { handle, ...(credentialId ? { credentialId } : {}), ...(scope !== undefined ? { scope } : {}) };
}

export function scopeAllowsSlug(scope: string | null | undefined, slug: string | undefined): boolean {
  return scope == null || (typeof slug === "string" && slug.startsWith(scope));
}

export function evaluateWriteGate(
  options: WriteGateOptions,
  identity: PublicActor | null,
): WriteGateResult {
  if (options.production && (options.authBypass || options.insecureCookies)) {
    return {
      ok: false,
      status: 403,
      body: { error: INSECURE_MODE_ERROR, code: "insecure_mode" },
    };
  }
  if (!identity) {
    return {
      ok: false,
      status: 401,
      body: { error: "A valid deploy token is required", code: "unauthorized" },
    };
  }
  return { ok: true, actor: publicActor(identity.handle, identity.credentialId, identity.scope) };
}

/**
 * Same-origin relative Location only. Rejects protocol-relative, absolute,
 * userinfo, and control-character targets so redirect/state query values
 * cannot become an open redirect.
 */
export function localRedirectPath(pathname: string): string {
  if (typeof pathname !== "string" || pathname.length === 0) {
    throw new Error("unsafe redirect");
  }
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.startsWith("/\\")) {
    throw new Error("unsafe redirect");
  }
  if (pathname.includes("\\") || pathname.includes("://") || /[\r\n\0]/.test(pathname)) {
    throw new Error("unsafe redirect");
  }
  let parsed: URL;
  try {
    parsed = new URL(pathname, "https://openquick.invalid");
  } catch {
    throw new Error("unsafe redirect");
  }
  if (parsed.origin !== "https://openquick.invalid" || parsed.username || parsed.password) {
    throw new Error("unsafe redirect");
  }
  if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) {
    throw new Error("unsafe redirect");
  }
  return parsed.pathname;
}

export function ignoreExternalRedirectState(searchParams: URLSearchParams): void {
  for (const key of ["redirect", "next", "return", "return_to", "state", "goto", "callback"]) {
    searchParams.delete(key);
  }
}
