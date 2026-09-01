import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import crypto from "node:crypto";

export const AGENT_HANDLE = /^[a-z][a-z0-9-]{1,61}$/;
export const ACTIVATION_TTL_MS = 15 * 60 * 1000;

export type ActivationStatus = "pending" | "approved" | "delivered" | "expired";

export type ActivationPublic = {
  id: string;
  handle: string;
  status: ActivationStatus;
  approvalUrl: string;
  pollUrl: string;
  expiresAt: string;
};

type ActivationRecord = {
  id: string;
  handle: string;
  status: Exclude<ActivationStatus, "expired">;
  expiresAt: string;
  clientSecretHash: string;
  deployTokenHash?: string;
  deployTokenPlain?: string;
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

  constructor(root: string) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.root, "activations"), { recursive: true });
  }

  async start(input: {
    handle: string;
    privateSink: boolean;
    origin: string;
    now?: number;
  }): Promise<ActivationPublic & { clientSecret: string }> {
    if (!input.privateSink) {
      throw Object.assign(new Error("A private credential sink is required"), { code: "no_private_sink" as const });
    }
    if (!AGENT_HANDLE.test(input.handle)) {
      throw Object.assign(new Error("Handle must be lowercase letters, numbers, or hyphens"), { code: "invalid_handle" as const });
    }
    const now = input.now ?? Date.now();
    const id = crypto.randomBytes(16).toString("hex");
    const clientSecret = `ocs_${crypto.randomBytes(24).toString("base64url")}`;
    const record: ActivationRecord = {
      id,
      handle: input.handle,
      status: "pending",
      expiresAt: new Date(now + ACTIVATION_TTL_MS).toISOString(),
      clientSecretHash: hashSecret(clientSecret),
    };
    await this.write(record);
    return {
      ...this.publicView(record, input.origin),
      clientSecret,
    };
  }

  async approve(id: string, origin: string, now = Date.now()): Promise<ActivationPublic> {
    const record = await this.load(id);
    if (!record || this.isExpired(record, now)) {
      throw Object.assign(new Error("Activation is expired or unknown"), { code: "expired" as const });
    }
    if (record.status !== "pending") {
      throw Object.assign(new Error("Activation is no longer pending"), { code: "replay" as const });
    }
    const deployToken = `oqt_${crypto.randomBytes(24).toString("base64url")}`;
    record.status = "approved";
    record.deployTokenPlain = deployToken;
    record.deployTokenHash = hashSecret(deployToken);
    await this.write(record);
    return this.publicView(record, origin);
  }

  async poll(id: string, clientSecret: string, now = Date.now()): Promise<{
    status: ActivationStatus;
    handle?: string;
    token?: string;
    expiresAt: string;
  }> {
    const record = await this.load(id);
    if (!record || !timingSafeEqualHex(record.clientSecretHash, hashSecret(clientSecret))) {
      throw Object.assign(new Error("Unknown activation"), { code: "unauthorized" as const });
    }
    if (this.isExpired(record, now) && record.status === "pending") {
      return { status: "expired", expiresAt: record.expiresAt };
    }
    if (record.status === "pending") {
      return { status: "pending", handle: record.handle, expiresAt: record.expiresAt };
    }
    if (record.status === "approved" && record.deployTokenPlain) {
      const token = record.deployTokenPlain;
      delete record.deployTokenPlain;
      record.status = "delivered";
      await this.write(record);
      return { status: "approved", handle: record.handle, token, expiresAt: record.expiresAt };
    }
    return { status: "delivered", handle: record.handle, expiresAt: record.expiresAt };
  }

  async authenticate(token: string): Promise<{ handle: string } | null> {
    if (!token.startsWith("oqt_")) return null;
    const hash = hashSecret(token);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(this.root, "activations")).catch(() => [] as string[]);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const record = await this.load(name.slice(0, -5));
      if (!record?.deployTokenHash) continue;
      if (timingSafeEqualHex(record.deployTokenHash, hash) && (record.status === "approved" || record.status === "delivered")) {
        return { handle: record.handle };
      }
    }
    return null;
  }

  async publicById(id: string, origin: string, now = Date.now()): Promise<ActivationPublic | null> {
    const record = await this.load(id);
    if (!record) return null;
    if (this.isExpired(record, now) && record.status === "pending") {
      return { ...this.publicView(record, origin), status: "expired" };
    }
    return this.publicView(record, origin);
  }

  private isExpired(record: ActivationRecord, now: number): boolean {
    return Date.parse(record.expiresAt) <= now;
  }

  private publicView(record: ActivationRecord, origin: string): ActivationPublic {
    return {
      id: record.id,
      handle: record.handle,
      status: record.status,
      approvalUrl: `${origin}/connect/${record.id}`,
      pollUrl: `${origin}/api/v1/agent-connections/${record.id}/poll`,
      expiresAt: record.expiresAt,
    };
  }

  private fileFor(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error("Unknown activation"), { code: "unauthorized" as const });
    return join(this.root, "activations", `${id}.json`);
  }

  private async load(id: string): Promise<ActivationRecord | null> {
    try {
      return JSON.parse(await readFile(this.fileFor(id), "utf8")) as ActivationRecord;
    } catch {
      return null;
    }
  }

  private async write(record: ActivationRecord): Promise<void> {
    await writeFile(this.fileFor(record.id), JSON.stringify(record, null, 2), { mode: 0o600 });
  }
}
