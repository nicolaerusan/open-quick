export type DeployFile = {
  path: string;
  content: string;
};

export type DeployPayload = {
  files: DeployFile[];
};

export type SiteRecord = {
  slug: string;
  releaseId: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredAsset = {
  bytes: Uint8Array;
  contentType: string;
  path: string;
};
