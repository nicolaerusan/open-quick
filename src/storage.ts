import type { AuditEvent, DeployFile, SiteRecord, StoredAsset } from "./types.js";

/** Key prefixes for the filesystem adapter. Future object stores should mirror these. */
export const STORAGE_PREFIX = {
  sites: "sites",
  releases: "releases",
  activePointer: "current.json",
  uploadStaging: ".upload-",
  pointerStaging: ".current-",
} as const;

export type OrphanCleanupResult = { removed: string[] };

/**
 * Typed site storage. Local tests use the filesystem adapter (`SiteStore`).
 * Folder-to-URL contract is unchanged: `/sites/{slug}/` and
 * `/sites/{slug}/releases/{releaseId}/`.
 */
export type SiteStorage = {
  initialize(): Promise<void>;
  deploy(slug: string, files: DeployFile[], deployedBy: string): Promise<SiteRecord>;
  site(slug: string): Promise<SiteRecord>;
  list(): Promise<SiteRecord[]>;
  history(slug: string): Promise<SiteRecord[]>;
  rollback(slug: string, releaseId: string, actor: string): Promise<{ site: SiteRecord; mutated: boolean }>;
  audit(slug: string): Promise<AuditEvent[]>;
  asset(slug: string, requested: string): Promise<StoredAsset>;
  assetAtRelease(slug: string, releaseId: string, requested: string): Promise<StoredAsset>;
  cleanupOrphans(): Promise<OrphanCleanupResult>;
};

export function isUploadStagingName(name: string): boolean {
  return name.startsWith(STORAGE_PREFIX.uploadStaging);
}

export function isPointerStagingName(name: string): boolean {
  return (
    name.startsWith(STORAGE_PREFIX.pointerStaging)
    && name.endsWith(".json")
    && name !== STORAGE_PREFIX.activePointer
  );
}

export function pointerStagingName(releaseId: string): string {
  return `${STORAGE_PREFIX.pointerStaging}${releaseId}.json`;
}

export function uploadStagingName(releaseId: string): string {
  return `${STORAGE_PREFIX.uploadStaging}${releaseId}`;
}
