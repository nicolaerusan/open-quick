export const OPENQUICK_RELEASE_SCHEMA = "openquick-release/v1" as const;
export const OPENQUICK_SERVICE = "openquick" as const;
export const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
export const DEPLOYMENT_ID_PATTERN = /^\S{1,256}$/;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

export type OpenQuickRelease = {
  schema: typeof OPENQUICK_RELEASE_SCHEMA;
  service: typeof OPENQUICK_SERVICE;
  sourceRevision: string;
  builtAt: string;
  deploymentId: string;
};

export class AttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationError";
  }
}

export type AttestationFields = {
  sourceRevision?: string | undefined;
  builtAt?: string | undefined;
  deploymentId?: string | undefined;
};

export type AttestationEnv = NodeJS.Dict<string>;

function isRfc3339Utc(value: string): boolean {
  const match = RFC3339_UTC.exec(value);
  if (!match) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseReleaseAttestation(fields: AttestationFields): OpenQuickRelease {
  const sourceRevision = fields.sourceRevision;
  const builtAt = fields.builtAt;
  const deploymentId = fields.deploymentId;
  if (!present(sourceRevision)) {
    throw new AttestationError("OPENQUICK_SOURCE_REVISION is required");
  }
  if (!SOURCE_REVISION_PATTERN.test(sourceRevision)) {
    throw new AttestationError("OPENQUICK_SOURCE_REVISION must be a 40-character lowercase git SHA");
  }
  if (!present(builtAt)) {
    throw new AttestationError("OPENQUICK_BUILT_AT is required");
  }
  if (!isRfc3339Utc(builtAt)) {
    throw new AttestationError("OPENQUICK_BUILT_AT must be an RFC 3339 UTC timestamp");
  }
  if (!present(deploymentId)) {
    throw new AttestationError("OPENQUICK_DEPLOYMENT_ID is required");
  }
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw new AttestationError("OPENQUICK_DEPLOYMENT_ID must be a non-empty opaque id without whitespace");
  }
  return {
    schema: OPENQUICK_RELEASE_SCHEMA,
    service: OPENQUICK_SERVICE,
    sourceRevision,
    builtAt,
    deploymentId,
  };
}

export function resolveReleaseAttestation(env: AttestationEnv): OpenQuickRelease | undefined {
  const sourceRevision = env.OPENQUICK_SOURCE_REVISION;
  const builtAt = env.OPENQUICK_BUILT_AT;
  const deploymentId = env.OPENQUICK_DEPLOYMENT_ID;
  const anyPresent = present(sourceRevision) || present(builtAt) || present(deploymentId);
  const production = env.NODE_ENV === "production";
  if (!production && !anyPresent) return undefined;
  return parseReleaseAttestation({ sourceRevision, builtAt, deploymentId });
}
