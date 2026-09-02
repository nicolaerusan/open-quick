export type DeployFile = {
  path: string;
  content: string;
};

export type DeployPayload = {
  files: DeployFile[];
};

export type RollbackPayload = {
  releaseId: string;
};

export type DeployErrorCode = "unauthorized" | "insecure_mode" | "payload_too_large" | "invalid_deployment" | "invalid_release";

export type DeployErrorResponse = {
  error: string;
  code: DeployErrorCode;
};

export type SiteRecord = {
  slug: string;
  releaseId: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
  deployedBy?: string;
};

export type DeployReceipt = {
  site: SiteRecord;
  url: string;
  releaseUrl: string;
};

export type SiteHistoryResponse = {
  site: SiteRecord;
  url: string;
  releaseUrl: string;
  fileCount: number;
  totalBytes: number;
  releases: SiteRecord[];
};

export type AuditEvent =
  | {
      type: "deploy";
      slug: string;
      releaseId: string;
      at: string;
      actor: string;
    }
  | {
      type: "rollback";
      slug: string;
      fromReleaseId: string;
      toReleaseId: string;
      at: string;
      actor: string;
    };

export type StoredAsset = {
  bytes: Uint8Array;
  contentType: string;
  path: string;
  mtime: Date;
};
