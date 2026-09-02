import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, posix, resolve, sep } from "node:path";
import crypto from "node:crypto";
import mime from "mime";
import type { AuditEvent, DeployFile, SiteRecord, StoredAsset } from "./types.js";
import type { OrphanCleanupResult, SiteStorage } from "./storage.js";
import {
  STORAGE_PREFIX,
  isPointerStagingName,
  isUploadStagingName,
  pointerStagingName,
  uploadStagingName,
} from "./storage.js";

export const MAX_FILE_COUNT = 500;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DEPLOY_BYTES = 25 * 1024 * 1024;
export const SITE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type PreparedFile = { path: string; bytes: Buffer };

export type SiteStoreErrorCode = "not_found" | "invalid_release";

export function storeError(code: SiteStoreErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
}

/** Reject traversal, temps, and anything that is not a single release folder name. */
export function isValidReleaseId(releaseId: string): boolean {
  if (typeof releaseId !== "string" || releaseId.length === 0 || releaseId.length > 128) return false;
  if (releaseId.includes("\0") || releaseId.includes("/") || releaseId.includes("\\")) return false;
  if (releaseId.includes("..") || releaseId.startsWith(".")) return false;
  if (/\s/.test(releaseId)) return false;
  if (posix.basename(releaseId) !== releaseId) return false;
  if (posix.normalize(releaseId) !== releaseId) return false;
  return true;
}

function safeAssetPath(input: string): string {
  const normalized = posix.normalize(input.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("\0")
  ) {
    throw new Error(`Unsafe asset path: ${input}`);
  }
  return normalized;
}

function contained(root: string, path: string): string {
  const target = resolve(root, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) throw new Error("Asset escaped release root");
  return target;
}

function prepareFiles(files: DeployFile[]): { files: PreparedFile[]; totalBytes: number } {
  if (!Array.isArray(files) || files.length === 0) throw new Error("A deploy needs at least one file");
  if (files.length > MAX_FILE_COUNT) throw new Error(`A deploy may contain at most ${MAX_FILE_COUNT} files`);

  const seen = new Set<string>();
  const prepared: PreparedFile[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new Error("Every file needs a path and base64 content");
    }
    const path = safeAssetPath(file.path);
    if (seen.has(path)) throw new Error(`Duplicate asset path: ${path}`);
    seen.add(path);
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== file.content.replace(/=+$/, "")) {
      throw new Error(`Invalid base64 content for ${path}`);
    }
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${path} exceeds the per-file limit`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_DEPLOY_BYTES) throw new Error("Deploy exceeds the total byte limit");
    prepared.push({ path, bytes });
  }
  return { files: prepared, totalBytes };
}

export class SiteStore implements SiteStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.root, STORAGE_PREFIX.sites), { recursive: true });
    await this.cleanupOrphans();
  }

  async deploy(slug: string, files: DeployFile[], deployedBy: string): Promise<SiteRecord> {
    if (!SITE_SLUG.test(slug)) throw new Error("Site slug must be lowercase letters, numbers, or hyphens");
    const prepared = prepareFiles(files);
    const now = new Date().toISOString();
    const existing = await this.site(slug).catch(() => null);
    const releaseId = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
    const siteRoot = join(this.root, "sites", slug);
    const releasesRoot = join(siteRoot, "releases");
    const temporary = join(releasesRoot, uploadStagingName(releaseId));
    const releaseRoot = join(releasesRoot, releaseId);
    const record: SiteRecord = {
      slug,
      releaseId,
      fileCount: prepared.files.length,
      totalBytes: prepared.totalBytes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deployedBy,
    };

    await mkdir(temporary, { recursive: true });
    try {
      for (const file of prepared.files) {
        const target = contained(temporary, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.bytes, { flag: "wx" });
      }
      await writeFile(join(temporary, "_openquick-release.json"), JSON.stringify(record, null, 2), { flag: "wx" });
      await rename(temporary, releaseRoot);
      await mkdir(siteRoot, { recursive: true });
      await this.activateRelease(siteRoot, record);
      await this.appendAudit({
        type: "deploy",
        slug,
        releaseId,
        at: record.updatedAt,
        actor: deployedBy,
      }).catch(() => undefined);
      return record;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      await rm(join(siteRoot, pointerStagingName(releaseId)), { force: true });
      throw error;
    }
  }

  async site(slug: string): Promise<SiteRecord> {
    if (!SITE_SLUG.test(slug)) throw new Error("Invalid site slug");
    return JSON.parse(await readFile(join(this.root, STORAGE_PREFIX.sites, slug, STORAGE_PREFIX.activePointer), "utf8")) as SiteRecord;
  }

  async list(): Promise<SiteRecord[]> {
    const entries = await readdir(join(this.root, "sites"), { withFileTypes: true });
    const records = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
      this.site(entry.name).catch(() => null),
    ));
    return records.filter((record): record is SiteRecord => record !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Metadata-only history; does not copy or read release asset bytes. Newest first. */
  async history(slug: string): Promise<SiteRecord[]> {
    if (!SITE_SLUG.test(slug)) throw storeError("not_found", "Invalid site slug");
    await this.site(slug).catch(() => {
      throw storeError("not_found", "Site not found");
    });
    const releasesRoot = join(this.root, "sites", slug, "releases");
    const entries = await readdir(releasesRoot, { withFileTypes: true }).catch(() => []);
    const records: SiteRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidReleaseId(entry.name)) continue;
      const record = await this.readReleaseRecord(slug, entry.name).catch(() => null);
      if (record) records.push(record);
    }
    return records.sort((a, b) => {
      const byTime = b.updatedAt.localeCompare(a.updatedAt);
      return byTime !== 0 ? byTime : b.releaseId.localeCompare(a.releaseId);
    });
  }

  /**
   * Atomically point current.json at an existing immutable release directory.
   * Repeating the same target is a no-op: same pointer, no extra audit row.
   */
  async rollback(slug: string, releaseId: string, actor: string): Promise<{ site: SiteRecord; mutated: boolean }> {
    if (!SITE_SLUG.test(slug)) throw storeError("not_found", "Invalid site slug");
    if (!isValidReleaseId(releaseId)) throw storeError("invalid_release", "Invalid release id");
    const current = await this.site(slug).catch(() => {
      throw storeError("not_found", "Site not found");
    });
    const target = await this.readReleaseRecord(slug, releaseId).catch((error) => {
      if (errorCode(error) === "invalid_release") throw error;
      throw storeError("invalid_release", "Release not found");
    });
    if (current.releaseId === target.releaseId) {
      return { site: current, mutated: false };
    }
    const siteRoot = join(this.root, "sites", slug);
    await this.activateRelease(siteRoot, target);
    await this.appendAudit({
      type: "rollback",
      slug,
      fromReleaseId: current.releaseId,
      toReleaseId: target.releaseId,
      at: new Date().toISOString(),
      actor,
    }).catch(() => undefined);
    return { site: target, mutated: true };
  }

  async audit(slug: string): Promise<AuditEvent[]> {
    if (!SITE_SLUG.test(slug)) throw storeError("not_found", "Invalid site slug");
    const raw = await readFile(join(this.root, "sites", slug, "audit.jsonl"), "utf8").catch(() => "");
    if (!raw.trim()) return [];
    return raw.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as AuditEvent);
  }

  async asset(slug: string, requested: string): Promise<StoredAsset> {
    const record = await this.site(slug);
    return this.readReleaseAsset(slug, record.releaseId, requested);
  }

  async assetAtRelease(slug: string, releaseId: string, requested: string): Promise<StoredAsset> {
    if (!SITE_SLUG.test(slug)) throw new Error("Invalid site slug");
    if (!isValidReleaseId(releaseId)) throw new Error("Invalid release id");
    return this.readReleaseAsset(slug, releaseId, requested);
  }


  async cleanupOrphans(): Promise<OrphanCleanupResult> {
    const removed: string[] = [];
    const sitesRoot = join(this.root, STORAGE_PREFIX.sites);
    const entries = await readdir(sitesRoot, { withFileTypes: true }).catch(() => []);
    for (const siteEntry of entries) {
      if (!siteEntry.isDirectory()) continue;
      const slug = siteEntry.name;
      const siteRoot = join(sitesRoot, slug);
      const siteFiles = await readdir(siteRoot, { withFileTypes: true }).catch(() => []);
      for (const file of siteFiles) {
        if (file.isFile() && isPointerStagingName(file.name)) {
          await rm(join(siteRoot, file.name), { force: true });
          removed.push(`${STORAGE_PREFIX.sites}/${slug}/${file.name}`);
        }
      }
      const releasesRoot = join(siteRoot, STORAGE_PREFIX.releases);
      const releaseEntries = await readdir(releasesRoot, { withFileTypes: true }).catch(() => []);
      for (const release of releaseEntries) {
        if (!isUploadStagingName(release.name)) continue;
        await rm(join(releasesRoot, release.name), { recursive: true, force: true });
        removed.push(`${STORAGE_PREFIX.sites}/${slug}/${STORAGE_PREFIX.releases}/${release.name}`);
      }
    }
    return { removed };
  }

  protected async activateRelease(siteRoot: string, record: SiteRecord): Promise<void> {
    const pointer = join(siteRoot, pointerStagingName(record.releaseId));
    await writeFile(pointer, JSON.stringify(record, null, 2), { flag: "wx" });
    await rename(pointer, join(siteRoot, STORAGE_PREFIX.activePointer));
  }

  private async appendAudit(event: AuditEvent): Promise<void> {
    const dir = join(this.root, "sites", event.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "audit.jsonl"), `${JSON.stringify(event)}\n`, { flag: "a" });
  }

  private async readReleaseRecord(slug: string, releaseId: string): Promise<SiteRecord> {
    if (!isValidReleaseId(releaseId)) throw storeError("invalid_release", "Invalid release id");
    const releasesRoot = join(this.root, "sites", slug, "releases");
    const releaseRoot = contained(releasesRoot, releaseId);
    const metaRaw = await readFile(join(releaseRoot, "_openquick-release.json"), "utf8").catch(() => null);
    if (!metaRaw) throw storeError("invalid_release", "Release not found");
    const record = JSON.parse(metaRaw) as SiteRecord;
    if (record.slug !== slug || record.releaseId !== releaseId) throw storeError("invalid_release", "Release not found");
    return record;
  }

  private async readReleaseAsset(slug: string, releaseId: string, requested: string): Promise<StoredAsset> {
    if (!isValidReleaseId(releaseId)) throw new Error("Invalid release id");
    const releasesRoot = join(this.root, "sites", slug, "releases");
    const releaseRoot = contained(releasesRoot, releaseId);
    const metaRaw = await readFile(join(releaseRoot, "_openquick-release.json"), "utf8").catch(() => null);
    if (!metaRaw) throw new Error("Release not found");
    const record = JSON.parse(metaRaw) as SiteRecord;
    if (record.slug !== slug || record.releaseId !== releaseId) throw new Error("Release not found");

    let path = safeAssetPath(requested || "index.html");
    let target = contained(releaseRoot, path);
    let info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      path = posix.join(path, "index.html");
      target = contained(releaseRoot, path);
      info = await stat(target).catch(() => null);
    }
    if (!info?.isFile() && !extname(path)) {
      path = "index.html";
      target = contained(releaseRoot, path);
      info = await stat(target).catch(() => null);
    }
    if (!info?.isFile()) throw new Error("Asset not found");
    return {
      bytes: await readFile(target),
      contentType: mime.getType(path) ?? "application/octet-stream",
      path,
      mtime: info.mtime,
    };
  }
}

export function createFilesystemStorage(root: string): SiteStorage {
  return new SiteStore(root);
}
