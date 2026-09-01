import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, posix, resolve, sep } from "node:path";
import crypto from "node:crypto";
import mime from "mime";
import type { DeployFile, SiteRecord, StoredAsset } from "./types.js";

export const MAX_FILE_COUNT = 500;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DEPLOY_BYTES = 25 * 1024 * 1024;
export const SITE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type PreparedFile = { path: string; bytes: Buffer };

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

export class SiteStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.root, "sites"), { recursive: true });
  }

  async deploy(slug: string, files: DeployFile[], deployedBy: string): Promise<SiteRecord> {
    if (!SITE_SLUG.test(slug)) throw new Error("Site slug must be lowercase letters, numbers, or hyphens");
    const prepared = prepareFiles(files);
    const now = new Date().toISOString();
    const existing = await this.site(slug).catch(() => null);
    const releaseId = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
    const siteRoot = join(this.root, "sites", slug);
    const releasesRoot = join(siteRoot, "releases");
    const temporary = join(releasesRoot, `.upload-${releaseId}`);
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
      const pointer = join(siteRoot, `.current-${releaseId}.json`);
      await writeFile(pointer, JSON.stringify(record, null, 2), { flag: "wx" });
      await rename(pointer, join(siteRoot, "current.json"));
      return record;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async site(slug: string): Promise<SiteRecord> {
    if (!SITE_SLUG.test(slug)) throw new Error("Invalid site slug");
    return JSON.parse(await readFile(join(this.root, "sites", slug, "current.json"), "utf8")) as SiteRecord;
  }

  async list(): Promise<SiteRecord[]> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(this.root, "sites"), { withFileTypes: true });
    const records = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
      this.site(entry.name).catch(() => null),
    ));
    return records.filter((record): record is SiteRecord => record !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
