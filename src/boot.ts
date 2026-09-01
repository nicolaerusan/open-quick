import { resolveReleaseAttestation, type OpenQuickRelease } from "./release-attestation.js";

export type BootConfig = {
  port: number;
  dataDir: string;
  adminToken: string;
  baseUrl?: string;
  attestation?: OpenQuickRelease;
};

export function loadBootConfig(env: NodeJS.Dict<string>): BootConfig {
  const port = Number(env.PORT ?? "3000");
  const dataDir = env.DATA_DIR ?? ".data";
  const production = env.NODE_ENV === "production";
  const adminToken = env.OPENQUICK_ADMIN_TOKEN ?? (production ? "" : "dev-token");
  if (!adminToken) throw new Error("OPENQUICK_ADMIN_TOKEN is required in production");
  const attestation = resolveReleaseAttestation(env);
  return {
    port: Number.isFinite(port) ? port : 3000,
    dataDir,
    adminToken,
    ...(env.BASE_URL ? { baseUrl: env.BASE_URL.replace(/\/$/, "") } : {}),
    ...(attestation ? { attestation } : {}),
  };
}
