export type DeployFile = {
  path: string;
  content: string;
};

export type DeployPayload = {
  files: DeployFile[];
};

export type DeployErrorCode = "unauthorized" | "payload_too_large" | "invalid_deployment";

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
};

export type StoredAsset = {
  bytes: Uint8Array;
  contentType: string;
  path: string;
};
