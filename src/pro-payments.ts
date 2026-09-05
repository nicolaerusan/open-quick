import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Challenge, Credential, Receipt, Store } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { isAddress } from "viem";
import type { SiteStorage } from "./storage.js";
import { prepareFiles } from "./store.js";
import type { DeployFile, SiteRecord } from "./types.js";
import { legacyQuote, newQuote, quoteAmount, quoteTermMs, validateQuote, type ProQuote, type QuoteDefaults } from "./pro-quote.js";
export { PRO_AMOUNT, PRO_CURRENCY, PRIVATE_HOSTING_TERM_MS } from "./pro-quote.js";

const hash = (input: string) => createHash("sha256").update(input).digest("hex");
export class ProError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export type ProOrder = {
  quote: ProQuote;
  recipient: string; id: string; actor: string; contentHash: string; slug: string; createdAt: string; expiresAt: string;
  status: "pending" | "processing" | "paid" | "published" | "needs_review";
  files?: DeployFile[]; reference?: string; receipt?: string; site?: SiteRecord;
  privateHosting?: { name: string; viewers: string[]; until?: string; origin?: string };
  fingerprint?: string;
};
export type ProConfig = { root: string; recipient: `0x${string}`; mainnetRecipient?: `0x${string}`; mainnetPayments?: boolean; secret: string; baseUrl: string; actors: string[]; privateHosting?: boolean; commonsHosts?: boolean; privateOrigins?: string[]; quote?: QuoteDefaults };
export type ProVerifier = (order: ProOrder, request: Request) => Promise<Response | { reference: string; receipt: string }>;

/** One process + mounted volume, matching OpenQuick's deployment topology. */
export class ProPayments {
  private readonly directory: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly verify: ProVerifier;
  private readonly quote: ProQuote;
  constructor(readonly config: ProConfig, private readonly sites: SiteStorage, verifier?: ProVerifier) {
    if (!isAddress(config.recipient) || /^0x0{40}$/i.test(config.recipient) || !/^[a-f0-9]{64}$/i.test(config.secret)) throw Error("Pro payments need a recipient and a 32-byte challenge secret");
    const origin = new URL(config.baseUrl);
    if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) throw Error("Pro payments need an HTTPS origin");
    if (config.mainnetRecipient && (!isAddress(config.mainnetRecipient) || /^0x0{40}$/i.test(config.mainnetRecipient))) throw Error("Invalid mainnet recipient");
    if (config.mainnetPayments && (!config.mainnetRecipient || !config.privateHosting)) throw Error("Mainnet Pro needs its own receiving address and private hosting product");
    if (config.quote?.network === "tempo-mainnet" && !config.mainnetPayments) throw Error("Mainnet charging is disabled");
    this.quote = newQuote(config.privateHosting === true, { ...config.quote, network: config.mainnetPayments ? "tempo-mainnet" : "tempo-testnet" });
    this.directory = join(config.root, "pro-orders"); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const replayStore = Store.memory();
    this.verify = verifier ?? (async (order, request) => {
      // Settlement is bound to stored terms. Enabling mainnet must not turn a
      // pending test purchase into a real charge or change a prior payee.
      const testnet = order.quote.network === "tempo-testnet";
      const mppx = Mppx.create({ secretKey: config.secret, realm: "openquick-pro", methods: [tempo.charge({ testnet, currency: order.quote.token, recipient: order.recipient as `0x${string}`, store: replayStore, waitForConfirmation: true })] });
      const result = await mppx.charge({ amount: quoteAmount(order.quote), description: order.privateHosting ? `OpenQuick Pro: private hosting for ${order.quote.termDays} days${testnet ? " (test)" : ""}` : "OpenQuick Pro: publish this static release (test)", externalId: order.id, scope: order.id, expires: order.expiresAt, memo: `0x${hash(order.id)}` })(request);
      if (result.status === 402) return result.challenge;
      const receipt = result.withReceipt(Response.json({})).headers.get("payment-receipt")!;
      const reference = Receipt.deserialize(receipt).reference;
      if (!reference || !/^0x[a-f0-9]{64}$/i.test(reference)) throw Error("Missing transaction receipt");
      return { reference: reference.toLowerCase(), receipt };
    });
  }
  private recipient(network: ProQuote["network"]) {
    const recipient = network === "tempo-mainnet" ? this.config.mainnetRecipient : this.config.recipient;
    if (!recipient) throw new ProError(503, "The receiving account needs operator configuration");
    return recipient;
  }
  offer() {
    return { ...this.quote, amount: quoteAmount(this.quote), recipient: this.recipient(this.quote.network), testMode: this.quote.network === "tempo-testnet" };
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
    const order = JSON.parse(readFileSync(path, "utf8")) as ProOrder;
    try {
      // Read-only compatibility for old receipts; the next state save persists
      // these legacy terms. An explicit malformed quote must not use defaults.
      order.quote = Object.hasOwn(order, "quote") ? validateQuote(order.quote, !!order.privateHosting) : legacyQuote(!!order.privateHosting);
      if (!!order.privateHosting !== (this.config.privateHosting === true)) throw Error("Wrong product store");
    } catch { throw new ProError(503, "Stored payment terms need operator review. Do not pay again."); }
    return order;
  }
  view(order: ProOrder) {
    const prefix = order.privateHosting ? "/api/v1/private-payments" : "/api/v1/pro-payments";
    const sitePrefix = order.privateHosting ? "/private" : "/sites";
    return { id: order.id, status: order.status === "processing" ? "needs_review" : order.status,
      product: order.privateHosting ? `OpenQuick private hosting · ${order.quote.termDays} days` : "OpenQuick Pro deploy",
      amount: quoteAmount(order.quote), amountAtomic: order.quote.amountAtomic, currency: order.quote.currency,
      network: order.quote.network, chainId: order.quote.chainId, token: order.quote.token, quoteVersion: order.quote.version, testMode: order.quote.network === "tempo-testnet",
      recipient: order.recipient, contentHash: order.contentHash, expiresAt: order.expiresAt,
      paymentUrl: `${this.config.baseUrl}${prefix}/${order.id}/pay`,
      checkoutUrl: order.privateHosting ? null : `${this.config.baseUrl}/pro/${order.id}`,
      ...(order.privateHosting?.origin ? { browserOrigin: order.privateHosting.origin } : {}),
      ...(order.privateHosting ? { visibility: "private", name: order.privateHosting.name, owner: order.actor, viewers: order.privateHosting.viewers, hostingUntil: order.privateHosting.until ?? null, termDays: order.quote.termDays } : {}),
      ...(order.reference ? { transaction: order.reference } : {}),
      ...(order.site ? { site: order.site, url: `${this.config.baseUrl}${sitePrefix}/${order.site.slug}/`, releaseUrl: `${this.config.baseUrl}${sitePrefix}/${order.site.slug}/releases/${order.site.releaseId}/` } : {}),
    };
  }
  private validateFiles(files: DeployFile[]) {
    const prepared = prepareFiles(files);
    if (prepared.totalBytes > 1_000_000 || files.length > 50) throw new ProError(413, "Pro pilot supports up to 50 files and 1 MB per release");
    const paths = new Set(prepared.files.map((file) => file.path));
    if (!paths.has("index.html")) throw new ProError(422, "A project needs index.html");
    if (paths.has("_openquick-release.json") || [...paths].some((path) => path.split("/").slice(0, -1).some((_, i, parts) => paths.has(parts.slice(0, i + 1).join("/"))))) throw new ProError(422, "Files conflict with a directory or reserved release metadata");
  }
  private validateViewers(viewers: unknown): string[] {
    if (!Array.isArray(viewers) || viewers.length > 20 || viewers.some((v) => typeof v !== "string" || !this.allowsActor(v))) throw new ProError(422, "Choose up to 20 approved pilot identities");
    return [...new Set(viewers)].sort();
  }
  allowsActor(actor: string) {
    return this.config.actors.includes(actor) || (this.config.privateHosting === true && this.config.commonsHosts === true && /^commons:[a-z0-9-]{1,64}$/.test(actor));
  }
  async create(actor: string, requestKey: string, files: DeployFile[], details?: { name: string; viewers: string[] }) {
    if (!this.allowsActor(actor)) throw new ProError(403, "Pro deploy is a private pilot; ask the operator for access");
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(requestKey)) throw new ProError(422, "Supply a stable Idempotency-Key (8–128 characters)");
    this.validateFiles(files);
    let privateHosting: ProOrder["privateHosting"];
    if (this.config.privateHosting) {
      if (!details || typeof details.name !== "string" || !details.name.trim() || details.name.trim().length > 80) throw new ProError(422, "Name this private project (1–80 characters)");
      privateHosting = { name: details.name.trim(), viewers: this.validateViewers(details.viewers) };
    } else if (details) throw new ProError(422, "Private hosting needs its own payment endpoint");
    const contentHash = hash(JSON.stringify(files));
    const fingerprint = hash(JSON.stringify({ contentHash, privateHosting }));
    // Secret-derived IDs prevent public guessing from an actor and idempotency key.
    const id = hash(`${this.config.secret}:${actor}:${requestKey}`).slice(0, 48);
    return this.lock(async () => {
      if (existsSync(this.path(id))) {
        const existing = this.read(id);
        if (existing.contentHash !== contentHash || (existing.fingerprint && existing.fingerprint !== fingerprint)) throw new ProError(409, "Idempotency-Key already used for different content or sharing settings");
        return this.view(existing);
      }
      const all = readdirSync(this.directory).filter((name) => name.endsWith(".json"));
      if (all.length >= 1000) throw new ProError(429, "Pilot intent capacity reached; operator cleanup required");
      const recent = all.map((name) => this.read(name.slice(0, -5))).filter((order) => order.actor === actor && Date.parse(order.createdAt) > Date.now() - 3600_000);
      if (recent.length >= 20) throw new ProError(429, "Pilot limit: 20 new intents per hour");
      if (privateHosting && this.config.privateOrigins) {
        const used = new Set(all.map((name) => this.read(name.slice(0, -5)).privateHosting?.origin));
        const origin = this.config.privateOrigins.find((candidate) => !used.has(candidate));
        if (!origin) throw new ProError(429, "Private hosting pilot is at capacity. The operator must add a dedicated project hostname before another purchase.");
        privateHosting.origin = origin;
      }
      const order: ProOrder = { quote: { ...this.quote }, recipient: this.recipient(this.quote.network), id, actor, contentHash, fingerprint, slug: `${privateHosting ? "oq-private" : "oq-pro"}-${randomBytes(12).toString("hex")}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "pending", files, ...(privateHosting ? { privateHosting } : {}) };
      this.save(order); return this.view(order);
    });
  }
  /** All private authorization reads durable state, including after a restart. */
  privateOrders() {
    if (!this.config.privateHosting) throw new ProError(404, "Not found");
    return readdirSync(this.directory).filter((name) => name.endsWith(".json")).map((name) => this.read(name.slice(0, -5)));
  }
  authorizeOrder(id: string, actor: string) {
    const order = this.read(id);
    if (!this.allowsActor(actor) || order.actor !== actor) throw new ProError(404, "Not found");
    return order;
  }
  project(slug: string, actor: string, ownerOnly = false) {
    const order = this.privateOrders().find((entry) => entry.slug === slug && entry.status === "published");
    if (!order?.privateHosting || !this.allowsActor(actor) || (order.actor !== actor && (ownerOnly || !order.privateHosting.viewers.includes(actor)))) throw new ProError(404, "Not found");
    if (!order.privateHosting.until || Date.parse(order.privateHosting.until) <= Date.now()) throw new ProError(410, "Private hosting has expired");
    return order;
  }
  async updateProject(slug: string, actor: string, files: DeployFile[]) {
    return this.lock(async () => {
      this.project(slug, actor, true);
      this.validateFiles(files);
      if ((await this.sites.history(slug)).length >= 100) throw new ProError(429, "Pilot limit: 100 releases per private project");
      return this.sites.deploy(slug, files, actor);
    });
  }
  async shareProject(slug: string, actor: string, viewers: unknown) {
    return this.lock(async () => {
      const order = this.project(slug, actor, true);
      order.privateHosting!.viewers = this.validateViewers(viewers);
      this.save(order);
      return this.view(order);
    });
  }
  async pay(id: string, request: Request): Promise<Response> {
    return this.lock(async () => {
      const order = this.read(id);
      const result = () => Response.json(this.view(order), { headers: order.receipt ? { "payment-receipt": order.receipt, "cache-control": "no-store" } : { "cache-control": "no-store" } });
      if (order.status === "published") return result();
      if (order.status === "processing" || order.status === "needs_review") throw new ProError(409, "Payment outcome needs operator review. Do not pay again.");
      if (order.status === "pending") {
        if (order.quote.network === "tempo-mainnet" && !this.config.mainnetPayments) throw new ProError(409, "Mainnet charging is paused. No payment was requested.");
        if (order.recipient.toLowerCase() !== this.recipient(order.quote.network).toLowerCase()) throw new ProError(409, "The receiving account changed. This unpaid intent is no longer payable.");
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
      if (order.privateHosting && !order.privateHosting.until) {
        order.privateHosting.until = new Date(Date.parse(order.site.createdAt) + quoteTermMs(order.quote)).toISOString();
      }
      order.status = "published"; delete order.files; this.save(order);
      return result();
    });
  }
}
