import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Challenge, Credential, Receipt, Store } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { isAddress } from "viem";
import type { SiteStorage } from "./storage.js";
import { prepareFiles } from "./store.js";
import type { DeployFile, SiteRecord } from "./types.js";

const hash = (input: string) => createHash("sha256").update(input).digest("hex");
export const PRO_AMOUNT = "0.01";
export const PRO_CURRENCY = "0x20c0000000000000000000000000000000000000";
export class ProError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export type ProOrder = {
  recipient: string; id: string; actor: string; contentHash: string; slug: string; createdAt: string; expiresAt: string;
  status: "pending" | "processing" | "paid" | "published" | "needs_review";
  files?: DeployFile[]; reference?: string; receipt?: string; site?: SiteRecord;
};
export type ProConfig = { root: string; recipient: `0x${string}`; secret: string; baseUrl: string; actors: string[] };
export type ProVerifier = (order: ProOrder, request: Request) => Promise<Response | { reference: string; receipt: string }>;

/** One process + mounted volume, matching OpenQuick's deployment topology. */
export class ProPayments {
  private readonly directory: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly verify: ProVerifier;
  constructor(readonly config: ProConfig, private readonly sites: SiteStorage, verifier?: ProVerifier) {
    if (!isAddress(config.recipient) || /^0x0{40}$/i.test(config.recipient) || !/^[a-f0-9]{64}$/i.test(config.secret)) throw Error("Pro payments need a recipient and a 32-byte challenge secret");
    const origin = new URL(config.baseUrl);
    if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) throw Error("Pro payments need an HTTPS origin");
    this.directory = join(config.root, "pro-orders"); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const mppx = Mppx.create({ secretKey: config.secret, realm: "openquick-pro", methods: [tempo.charge({ testnet: true, currency: PRO_CURRENCY, recipient: config.recipient, store: Store.memory(), waitForConfirmation: true })] });
    this.verify = verifier ?? (async (order, request) => {
      const result = await mppx.charge({ amount: PRO_AMOUNT, description: "OpenQuick Pro: publish this static release (test)", externalId: order.id, scope: order.id, expires: order.expiresAt, memo: `0x${hash(order.id)}` })(request);
      if (result.status === 402) return result.challenge;
      const receipt = result.withReceipt(Response.json({})).headers.get("payment-receipt")!;
      const reference = Receipt.deserialize(receipt).reference;
      if (!reference || !/^0x[a-f0-9]{64}$/i.test(reference)) throw Error("Missing transaction receipt");
      return { reference: reference.toLowerCase(), receipt };
    });
  }
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn); this.tail = run.catch(() => undefined); return run;
  }
  private path(id: string) {
    if (!/^[a-f0-9]{48}$/.test(id)) throw new ProError(404, "Payment intent not found");
    return join(this.directory, `${id}.json`);
  }
  private save(order: ProOrder) {
    const path = this.path(order.id); const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(order), { mode: 0o600 });
    const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const dir = openSync(this.directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  read(id: string): ProOrder {
    const path = this.path(id);
    if (!existsSync(path)) throw new ProError(404, "Payment intent not found");
    return JSON.parse(readFileSync(path, "utf8")) as ProOrder;
  }
  view(order: ProOrder) {
    return { id: order.id, status: order.status === "processing" ? "needs_review" : order.status,
      product: "OpenQuick Pro deploy", amount: PRO_AMOUNT, currency: "pathUSD", network: "tempo-testnet", testMode: true,
      recipient: order.recipient, contentHash: order.contentHash, expiresAt: order.expiresAt,
      paymentUrl: `${this.config.baseUrl}/api/v1/pro-payments/${order.id}/pay`,
      checkoutUrl: `${this.config.baseUrl}/pro/${order.id}`,
      ...(order.reference ? { transaction: order.reference } : {}),
      ...(order.site ? { site: order.site, url: `${this.config.baseUrl}/sites/${order.site.slug}/`, releaseUrl: `${this.config.baseUrl}/sites/${order.site.slug}/releases/${order.site.releaseId}/` } : {}),
    };
  }
  async create(actor: string, requestKey: string, files: DeployFile[]) {
    if (!this.config.actors.includes(actor)) throw new ProError(403, "Pro deploy is a private pilot; ask the operator for access");
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(requestKey)) throw new ProError(422, "Supply a stable Idempotency-Key (8–128 characters)");
    const prepared = prepareFiles(files);
    if (prepared.totalBytes > 1_000_000 || files.length > 50) throw new ProError(413, "Pro pilot supports up to 50 files and 1 MB per release");
    const paths = new Set(prepared.files.map((file) => file.path));
    if (paths.has("_openquick-release.json") || [...paths].some((path) => path.split("/").slice(0, -1).some((_, i, parts) => paths.has(parts.slice(0, i + 1).join("/"))))) throw new ProError(422, "Files conflict with a directory or reserved release metadata");
    const contentHash = hash(JSON.stringify(files));
    // Secret-derived IDs prevent public guessing from an actor and idempotency key.
    const id = hash(`${this.config.secret}:${actor}:${requestKey}`).slice(0, 48);
    return this.lock(async () => {
      if (existsSync(this.path(id))) {
        const existing = this.read(id);
        if (existing.contentHash !== contentHash) throw new ProError(409, "Idempotency-Key already used for different content");
        return this.view(existing);
      }
      const all = readdirSync(this.directory).filter((name) => name.endsWith(".json"));
      if (all.length >= 1000) throw new ProError(429, "Pilot intent capacity reached; operator cleanup required");
      const recent = all.map((name) => this.read(name.slice(0, -5))).filter((order) => order.actor === actor && Date.parse(order.createdAt) > Date.now() - 3600_000);
      if (recent.length >= 20) throw new ProError(429, "Pilot limit: 20 new intents per hour");
      const order: ProOrder = { recipient: this.config.recipient, id, actor, contentHash, slug: `oq-pro-${randomBytes(12).toString("hex")}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "pending", files };
      this.save(order); return this.view(order);
    });
  }
  async pay(id: string, request: Request): Promise<Response> {
    return this.lock(async () => {
      const order = this.read(id);
      const result = () => Response.json(this.view(order), { headers: order.receipt ? { "payment-receipt": order.receipt, "cache-control": "no-store" } : { "cache-control": "no-store" } });
      if (order.status === "published") return result();
      if (order.status === "processing" || order.status === "needs_review") throw new ProError(409, "Payment outcome needs operator review. Do not pay again.");
      if (order.status === "pending") {
        if (order.recipient.toLowerCase() !== this.config.recipient.toLowerCase()) throw new ProError(409, "The receiving account changed. This unpaid intent is no longer payable.");
        if (Date.parse(order.expiresAt) <= Date.now()) throw new ProError(410, "Intent expired. No payment was requested.");
        const proof = request.headers.get("payment-authorization") ?? request.headers.get("authorization");
        if (!proof) {
          const challenge = await this.verify(order, request);
          if (!(challenge instanceof Response)) throw new ProError(502, "Provider accepted a request without payment");
          return challenge;
        }
        if (proof.length > 24_000) throw new ProError(413, "Payment credential too large");
        try {
          const credential = Credential.deserialize(proof);
          if (!Challenge.verify(credential.challenge, { secretKey: this.config.secret }) || credential.challenge.request.externalId !== order.id || credential.challenge.method !== "tempo" || credential.challenge.intent !== "charge") throw Error();
        } catch { throw new ProError(422, "Use the MPP challenge issued for this intent"); }
        order.status = "processing"; this.save(order);
        try {
          const verified = await this.verify(order, request);
          if (verified instanceof Response) throw Error("Unconfirmed payment");
          // Defense in depth if a provider ever accepts one tx for another intent.
          for (const name of readdirSync(this.directory).filter((n) => n.endsWith(".json"))) {
            const other = this.read(name.slice(0, -5));
            if (other.id !== id && other.reference === verified.reference) throw Error("Duplicate transaction");
          }
          order.reference = verified.reference; order.receipt = verified.receipt; order.status = "paid"; this.save(order);
        } catch { order.status = "needs_review"; this.save(order); throw new ProError(503, "Payment outcome needs operator review. Do not pay again."); }
      }
      // A paid order can retry publication after an interrupted process. Its
      // private, reserved slug and content are fixed before payment.
      const existing = await this.sites.site(order.slug).catch(() => null);
      order.site = existing ?? await this.sites.deploy(order.slug, order.files!, order.actor);
      order.status = "published"; delete order.files; this.save(order);
      return result();
    });
  }
}
