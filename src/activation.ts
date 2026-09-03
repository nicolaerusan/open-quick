import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import crypto from "node:crypto";

export const AGENT_HANDLE = /^[a-z][a-z0-9-]{1,61}$/;
export const SLUG_PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,61})?$/;
export const ACTIVATION_TTL_MS = 15 * 60 * 1000;

export type ActivationStatus = "pending" | "approved" | "delivered" | "expired";
export type CredentialScope = string | null;
export type CredentialPublic = { id: string; scope: CredentialScope; created_at: string; last_used_at: string | null; revoked_at: string | null };
export type CredentialIdentity = { handle: string; credentialId: string; scope: CredentialScope };
export type CredentialAuditEvent = {
  type: "credential_mint" | "credential_revoke" | "credential_use_after_revoke";
  credential_id: string;
  handle: string;
  at: string;
};

export type ActivationPublic = {
  id: string;
  handle: string;
  status: ActivationStatus;
  scope: CredentialScope;
  approvalUrl: string;
  pollUrl: string;
  expiresAt: string;
};

export type ActivationStart = ActivationPublic & { clientSecret: string; approvalCode: string };

type ActivationRecord = {
  id: string;
  handle: string;
  status: Exclude<ActivationStatus, "expired">;
  scope?: CredentialScope;
  expiresAt: string;
  clientSecretHash: string;
  pendingDeployTokenHash?: string;
  approvalCodeHash: string;
  approvalAttempts?: number;
  deployTokenHash?: string;
  createdAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

function hashSecret(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export class ActivationStore {
  readonly root: string;

  constructor(root: string) { this.root = resolve(root); }

  async initialize(): Promise<void> {
    await mkdir(join(this.root, "activations"), { recursive: true });
  }

  async start(input: {
    handle: string;
    privateSink: boolean;
    origin: string;
    scope?: CredentialScope;
    now?: number;
  }): Promise<ActivationStart> {
    if (!input.privateSink) throw Object.assign(new Error("A private credential sink is required"), { code: "no_private_sink" as const });
    if (!AGENT_HANDLE.test(input.handle)) throw Object.assign(new Error("Handle must be lowercase letters, numbers, or hyphens"), { code: "invalid_handle" as const });
    if (input.scope !== undefined && input.scope !== null && !SLUG_PREFIX.test(input.scope)) {
      throw Object.assign(new Error("Scope must be a valid site slug prefix"), { code: "invalid_scope" as const });
    }
    const now = input.now ?? Date.now();
    const existing = (await this.credentialRecords()).find((record) => record.handle === input.handle && !record.revokedAt);
    if (existing) throw Object.assign(new Error("That handle is already connected"), { code: "handle_taken" as const });
    const id = crypto.randomBytes(16).toString("hex");
    const clientSecret = `ocs_${crypto.randomBytes(24).toString("base64url")}`;
    const approvalCode = crypto.randomInt(100000, 1000000).toString();
    const deployToken = `oqt_${clientSecret.slice("ocs_".length)}`;
    const record: ActivationRecord = {
      id,
      handle: input.handle,
      status: "pending",
      scope: input.scope ?? null,
      expiresAt: new Date(now + ACTIVATION_TTL_MS).toISOString(),
      clientSecretHash: hashSecret(clientSecret),
      pendingDeployTokenHash: hashSecret(deployToken),
      approvalCodeHash: hashSecret(approvalCode),
      approvalAttempts: 0,
    };
    await this.write(record);
    return { ...this.publicView(record, input.origin), clientSecret, approvalCode };
  }

  async approve(id: string, origin: string, approvalCode: string, now = Date.now()): Promise<ActivationPublic> {
    const record = await this.load(id);
    if (!record || this.isExpired(record, now)) throw Object.assign(new Error("Activation is expired or unknown"), { code: "expired" as const });
    if (record.status !== "pending") throw Object.assign(new Error("Activation is no longer pending"), { code: "replay" as const });
    if ((record.approvalAttempts ?? 0) >= 5 || !/^[0-9]{6}$/.test(approvalCode) || !timingSafeEqualHex(record.approvalCodeHash, hashSecret(approvalCode))) {
      record.approvalAttempts = (record.approvalAttempts ?? 0) + 1;
      await this.write(record);
      throw Object.assign(new Error("Invalid approval code"), { code: "invalid_code" as const });
    }
    record.status = "approved";
    if (!record.pendingDeployTokenHash) throw Object.assign(new Error("Activation cannot mint a credential"), { code: "expired" as const });
    record.deployTokenHash = record.pendingDeployTokenHash;
    delete record.pendingDeployTokenHash;
    record.createdAt = new Date(now).toISOString();
    await this.write(record);
    await this.appendAudit({ type: "credential_mint", credential_id: record.id, handle: record.handle, at: record.createdAt });
    return this.publicView(record, origin);
  }

  async poll(id: string, clientSecret: string, now = Date.now()): Promise<{ status: ActivationStatus; handle?: string; token?: string; expiresAt: string }> {
    const record = await this.load(id);
    if (!record || !timingSafeEqualHex(record.clientSecretHash, hashSecret(clientSecret))) {
      throw Object.assign(new Error("Unknown activation"), { code: "unauthorized" as const });
    }
    if (this.isExpired(record, now) && record.status === "pending") return { status: "expired", expiresAt: record.expiresAt };
    if (record.status === "pending") return { status: "pending", handle: record.handle, expiresAt: record.expiresAt };
    if (record.status === "approved" && record.deployTokenHash) {
      const token = `oqt_${clientSecret.slice("ocs_".length)}`;
      if (!timingSafeEqualHex(record.deployTokenHash, hashSecret(token))) throw Object.assign(new Error("Unknown activation"), { code: "unauthorized" as const });
      record.status = "delivered";
      await this.write(record);
      return { status: "approved", handle: record.handle, token, expiresAt: record.expiresAt };
    }
    return { status: "delivered", handle: record.handle, expiresAt: record.expiresAt };
  }

  /** Reads disk on every call so revocation takes effect immediately. */
  async authenticate(token: string, now = Date.now()): Promise<CredentialIdentity | null> {
    if (!token.startsWith("oqt_")) return null;
    const hash = hashSecret(token);
    for (const record of await this.credentialRecords()) {
      if (!record.deployTokenHash || !timingSafeEqualHex(record.deployTokenHash, hash)) continue;
      if (record.revokedAt) {
        await this.appendAudit({ type: "credential_use_after_revoke", credential_id: record.id, handle: record.handle, at: new Date(now).toISOString() });
        return null;
      }
      if (record.status !== "approved" && record.status !== "delivered") return null;
      record.lastUsedAt = new Date(now).toISOString();
      await this.write(record);
      return { handle: record.handle, credentialId: record.id, scope: record.scope ?? null };
    }
    return null;
  }

  async listCredentials(handle: string): Promise<CredentialPublic[]> {
    const records = (await this.credentialRecords()).filter((record) => record.handle === handle && record.deployTokenHash);
    return records.map((record) => this.credentialView(record)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async revoke(id: string, handle: string, now = Date.now()): Promise<boolean> {
    const record = await this.load(id);
    if (!record?.deployTokenHash || record.handle !== handle) return false;
    if (!record.revokedAt) {
      record.revokedAt = new Date(now).toISOString();
      await this.write(record);
      await this.appendAudit({ type: "credential_revoke", credential_id: record.id, handle: record.handle, at: record.revokedAt });
    }
    return true;
  }

  async audit(): Promise<CredentialAuditEvent[]> {
    const raw = await readFile(join(this.root, "credential-audit.jsonl"), "utf8").catch(() => "");
    if (!raw.trim()) return [];
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CredentialAuditEvent);
  }

  async publicById(id: string, origin: string, now = Date.now()): Promise<ActivationPublic | null> {
    const record = await this.load(id);
    if (!record) return null;
    if (this.isExpired(record, now) && record.status === "pending") return { ...this.publicView(record, origin), status: "expired" };
    return this.publicView(record, origin);
  }

  private isExpired(record: ActivationRecord, now: number): boolean { return Date.parse(record.expiresAt) <= now; }

  private publicView(record: ActivationRecord, origin: string): ActivationPublic {
    return {
      id: record.id, handle: record.handle, status: record.status, scope: record.scope ?? null,
      approvalUrl: `${origin}/connect/${record.id}`,
      pollUrl: `${origin}/api/v1/agent-connections/${record.id}/poll`,
      expiresAt: record.expiresAt,
    };
  }

  private credentialView(record: ActivationRecord): CredentialPublic {
    return {
      id: record.id,
      scope: record.scope ?? null,
      created_at: record.createdAt ?? new Date(Date.parse(record.expiresAt) - ACTIVATION_TTL_MS).toISOString(),
      last_used_at: record.lastUsedAt ?? null,
      revoked_at: record.revokedAt ?? null,
    };
  }

  private fileFor(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error("Unknown activation"), { code: "unauthorized" as const });
    return join(this.root, "activations", `${id}.json`);
  }

  private async credentialRecords(): Promise<ActivationRecord[]> {
    const entries = await readdir(join(this.root, "activations")).catch(() => [] as string[]);
    const records: ActivationRecord[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const record = await this.load(name.slice(0, -5));
      if (record) records.push(record);
    }
    return records;
  }

  private async load(id: string): Promise<ActivationRecord | null> {
    try { return JSON.parse(await readFile(this.fileFor(id), "utf8")) as ActivationRecord; }
    catch { return null; }
  }

  private async write(record: ActivationRecord): Promise<void> {
    await writeFile(this.fileFor(record.id), JSON.stringify(record, null, 2), { mode: 0o600 });
  }

  private async appendAudit(event: CredentialAuditEvent): Promise<void> {
    await writeFile(join(this.root, "credential-audit.jsonl"), `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 });
  }
}
