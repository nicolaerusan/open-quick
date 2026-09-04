import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

/** Later paid threshold; not a live gate while enforcePaywall is false. */
export const SANDBOX_PAID_THRESHOLD = 5;
export const SANDBOX_PRODUCT_ID = "openquick.deploy-pack.sandbox";
export const SANDBOX_NETWORK = "eip155:84532";
export const SANDBOX_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const SANDBOX_PAY_TO = "0x71Bd8f02b8821B0731F70Ec083EB104FdFD58385";
export const SANDBOX_AMOUNT = "10000";
export const SANDBOX_SCHEME = "exact";
export const SANDBOX_OPERATION = "deploy-pack";
export const SANDBOX_METHOD = "POST";
export const SANDBOX_ROUTE_TEMPLATE = "/v1/sites/{site}/deploys";
export const SANDBOX_MAX_TIMEOUT = 60;
export const PAYMENT_IDENTIFIER_EXT = "payment-identifier";
export const OPERATOR_BYPASS_HEADER = "X-OpenQuick-Operator-Token";
export const SANDBOX_X402_ENV = "OPENQUICK_SANDBOX_X402";

const FINGERPRINT_KEYS = [
  "scheme",
  "network",
  "asset",
  "amount",
  "payTo",
  "method",
  "route",
  "principal",
  "site",
  "operation",
] as const;

const BANNED_LEDGER = ["api_key", "apikey", "private_key", "hmac_secret", "authorization"];

export type FingerprintFields = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  method: string;
  route: string;
  principal: string;
  site: string;
  operation: string;
};

export type LedgerEvent = {
  seq: number;
  ts: number;
  type: "credit" | "debit" | "free_consume";
  principal: string;
  site: string;
  units: number;
  fingerprint?: string;
  paymentIdentifier?: string;
  deployId?: string;
  productId?: string;
  freeQuota?: number;
  extra?: Record<string, string>;
  [key: string]: unknown;
};

export type PaymentRequiredBody = {
  x402Version: 2;
  error: string;
  productId: string;
  amount: string;
  currency: string;
  network: string;
  expiresAt: number;
  resource: { url: string; description: string; mimeType: string };
  accepts: Record<string, unknown>[];
  supportedOffer: Record<string, unknown>;
  extensions: Record<string, unknown>;
  idempotency: { paymentIdentifier: string; binding: string[] };
  sandbox: true;
  principal: string;
  site: string;
};

export type PaymentRequiredResponse = {
  status: 402;
  headers: { "PAYMENT-REQUIRED": string; "Content-Type": string };
  body: PaymentRequiredBody;
};

export type DeployOutcome = "active" | "failed" | "partial";

export type DeployResult = Record<string, unknown> & { status: number };

export type VerifiedSettlement = {
  paymentIdentifier: string;
  principal: string;
  site: string;
  amount: string;
  asset: string;
  network: string;
  payTo: string;
  scheme: string;
  productId: string;
  credits: number;
  expiresAt: number;
  verifiedAt: number;
  latencyMs: number;
};

export class ConflictError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export class ProviderDownError extends Error {
  readonly status = 503;
  constructor(message = "payment provider marked down; fail closed") {
    super(message);
  }
}

export class InvalidProofError extends Error {
  readonly reason: string;
  readonly status = 403;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort()) out[key] = sortKeys(rec[key]);
    return out;
  }
  return value;
}

export function fingerprint(fields: FingerprintFields): string {
  const missing = FINGERPRINT_KEYS.filter((k) => fields[k] === undefined || fields[k] === "");
  if (missing.length) throw new Error(`fingerprint missing fields: ${missing.join(",")}`);
  const payload: Record<string, string> = {};
  for (const k of FINGERPRINT_KEYS) payload[k] = String(fields[k]);
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function offerFields(input: {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  method: string;
  route: string;
  principal: string;
  site: string;
  operation: string;
}): FingerprintFields {
  return {
    scheme: input.scheme,
    network: input.network,
    asset: input.asset,
    amount: input.amount,
    payTo: input.payTo,
    method: input.method,
    route: input.route,
    principal: input.principal,
    site: input.site,
    operation: input.operation,
  };
}

export function generatePaymentId(prefix = "pay_"): string {
  return prefix + randomBytes(16).toString("hex");
}

export function sandboxX402Enabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env[SANDBOX_X402_ENV] === "1";
}

function refuseCredentialLike(blob: string): void {
  const lowered = blob.toLowerCase();
  for (const banned of BANNED_LEDGER) {
    if (lowered.includes(banned)) throw new Error("refusing to persist credential-like field");
  }
}

export class JsonlLedger {
  readonly path: string | undefined;
  private events: LedgerEvent[] = [];
  private readonly mutex = new AsyncMutex();

  constructor(path?: string) {
    this.path = path;
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      this.reload();
    }
  }

  withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.mutex.run(fn);
  }

  reload(): void {
    this.events = [];
    const path = this.path;
    if (!path || !existsSync(path)) return;
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      this.events.push(JSON.parse(line) as LedgerEvent);
    }
  }

  readEvents(): LedgerEvent[] {
    return [...this.events];
  }

  private nextSeq(): number {
    if (this.events.length === 0) return 1;
    return Math.max(...this.events.map((e) => e.seq)) + 1;
  }

  private appendUnlocked(event: Omit<LedgerEvent, "seq" | "ts"> & { ts?: number }): LedgerEvent {
    const rec = {
      ...event,
      seq: this.nextSeq(),
      ts: event.ts ?? Date.now() / 1000,
    } as LedgerEvent;
    const blob = canonicalJson(rec);
    refuseCredentialLike(blob);
    this.events.push(rec);
    const path = this.path;
    if (path) {
      const fd = openSync(path, "a");
      try {
        appendFileSync(fd, blob + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return rec;
  }

  eventsFor(principal: string, site: string): LedgerEvent[] {
    return this.events.filter((e) => e.principal === principal && e.site === site);
  }

  balance(principal: string, site: string): number {
    let bal = 0;
    for (const e of this.eventsFor(principal, site)) {
      if (e.type === "credit") bal += e.units;
      else if (e.type === "debit") bal -= e.units;
    }
    return bal;
  }

  /** Deploy meter: free consumes plus paid debits (active deploys only). */
  deployMeter(principal: string, site: string): number {
    return this.eventsFor(principal, site).filter((e) => e.type === "free_consume" || e.type === "debit").length;
  }

  freeUsed(principal: string, site: string): number {
    return this.eventsFor(principal, site)
      .filter((e) => e.type === "free_consume")
      .reduce((sum, e) => sum + e.units, 0);
  }

  findSettlement(paymentIdentifier: string): LedgerEvent | undefined {
    return this.events.find((e) => e.type === "credit" && e.paymentIdentifier === paymentIdentifier);
  }

  findDeployDebit(deployId: string): LedgerEvent | undefined {
    return this.events.find((e) => e.type === "debit" && e.deployId === deployId);
  }

  findFreeDeploy(deployId: string): LedgerEvent | undefined {
    return this.events.find((e) => e.type === "free_consume" && e.deployId === deployId);
  }

  creditSettlement(input: {
    principal: string;
    site: string;
    units: number;
    paymentIdentifier: string;
    fingerprint: string;
    productId: string;
    extra?: Record<string, string>;
  }): LedgerEvent & { idempotentReplay: boolean } {
    const existing = this.findSettlement(input.paymentIdentifier);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) {
        throw new ConflictError("payment-identifier bound to a different fingerprint", 409);
      }
      return { ...existing, idempotentReplay: true };
    }
    const event: Omit<LedgerEvent, "seq" | "ts"> = {
      type: "credit",
      principal: input.principal,
      site: input.site,
      units: input.units,
      paymentIdentifier: input.paymentIdentifier,
      fingerprint: input.fingerprint,
      productId: input.productId,
    };
    if (input.extra) event.extra = input.extra;
    const written = this.appendUnlocked(event);
    return { ...written, idempotentReplay: false };
  }

  debitActiveDeploy(input: {
    principal: string;
    site: string;
    units: number;
    deployId: string;
    fingerprint: string;
    productId: string;
  }): LedgerEvent & { idempotentReplay: boolean } {
    const existing = this.findDeployDebit(input.deployId);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) {
        throw new ConflictError("deployId bound to a different fingerprint", 409);
      }
      return { ...existing, idempotentReplay: true };
    }
    if (this.balance(input.principal, input.site) < input.units) {
      throw new ConflictError("insufficient credit", 402);
    }
    const written = this.appendUnlocked({
      type: "debit",
      principal: input.principal,
      site: input.site,
      units: input.units,
      deployId: input.deployId,
      fingerprint: input.fingerprint,
      productId: input.productId,
    });
    return { ...written, idempotentReplay: false };
  }

  consumeFree(input: {
    principal: string;
    site: string;
    units: number;
    deployId: string;
    freeQuota: number;
  }): LedgerEvent & { idempotentReplay: boolean } {
    const existing = this.findFreeDeploy(input.deployId);
    if (existing) return { ...existing, idempotentReplay: true };
    const used = this.freeUsed(input.principal, input.site);
    if (used + input.units > input.freeQuota) {
      throw new ConflictError("free quota exhausted", 402);
    }
    const written = this.appendUnlocked({
      type: "free_consume",
      principal: input.principal,
      site: input.site,
      units: input.units,
      deployId: input.deployId,
      freeQuota: input.freeQuota,
    });
    return { ...written, idempotentReplay: false };
  }
}

export class PaymentRequiredBuilder {
  productId: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  scheme: string;
  maxTimeoutSeconds: number;
  creditsPerPack: number;

  constructor(opts: Partial<PaymentRequiredBuilder> = {}) {
    this.productId = opts.productId ?? SANDBOX_PRODUCT_ID;
    this.network = opts.network ?? SANDBOX_NETWORK;
    this.asset = opts.asset ?? SANDBOX_ASSET;
    this.payTo = opts.payTo ?? SANDBOX_PAY_TO;
    this.amount = opts.amount ?? SANDBOX_AMOUNT;
    this.scheme = opts.scheme ?? SANDBOX_SCHEME;
    this.maxTimeoutSeconds = opts.maxTimeoutSeconds ?? SANDBOX_MAX_TIMEOUT;
    this.creditsPerPack = opts.creditsPerPack ?? 1;
  }

  routeFor(site: string): string {
    return SANDBOX_ROUTE_TEMPLATE.replace("{site}", site);
  }

  offer(): Record<string, unknown> {
    return {
      scheme: this.scheme,
      network: this.network,
      amount: this.amount,
      asset: this.asset,
      payTo: this.payTo,
      maxTimeoutSeconds: this.maxTimeoutSeconds,
      extra: {
        name: "USDC",
        version: "2",
        productId: this.productId,
        credits: this.creditsPerPack,
        sandbox: true,
        notProduction: true,
      },
    };
  }

  build(input: {
    principal: string;
    site: string;
    paymentIdentifier?: string;
    now?: number;
    error?: string;
  }): PaymentRequiredResponse {
    const now = input.now ?? Date.now() / 1000;
    const pid = input.paymentIdentifier ?? generatePaymentId();
    const expiresAt = Math.floor(now) + this.maxTimeoutSeconds;
    const offer = this.offer();
    const body: PaymentRequiredBody = {
      x402Version: 2,
      error: input.error ?? "PAYMENT-SIGNATURE header is required",
      productId: this.productId,
      amount: this.amount,
      currency: "USDC",
      network: this.network,
      expiresAt,
      resource: {
        url: `https://sandbox.openquick.local${this.routeFor(input.site)}`,
        description: "OpenQuick sandbox deploy pack after free quota (not production payment)",
        mimeType: "application/json",
      },
      accepts: [offer],
      supportedOffer: offer,
      extensions: {
        [PAYMENT_IDENTIFIER_EXT]: {
          info: { required: true },
          schema: { type: "object" },
        },
      },
      idempotency: {
        paymentIdentifier: pid,
        binding: [
          "scheme",
          "network",
          "asset",
          "amount",
          "payTo",
          "method",
          "route",
          "principal",
          "site",
          "operation",
        ],
      },
      sandbox: true,
      principal: input.principal,
      site: input.site,
    };
    const encoded = Buffer.from(canonicalJson(body), "utf8").toString("base64");
    return {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encoded,
        "Content-Type": "application/json",
      },
      body,
    };
  }

  decodeHeader(headerValue: string): PaymentRequiredBody {
    return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as PaymentRequiredBody;
  }
}

export class SandboxX402ExactAdapter {
  private readonly hmacKey: Buffer;
  private down: boolean;
  readonly expectedPayTo: string;
  readonly expectedAmount: string;
  readonly expectedAsset: string;
  readonly expectedNetwork: string;
  readonly expectedScheme: string;
  readonly expectedProductId: string;
  readonly creditsPerPack: number;

  constructor(
    hmacKey: Buffer | string,
    opts: {
      expectedPayTo?: string;
      expectedAmount?: string;
      expectedAsset?: string;
      expectedNetwork?: string;
      expectedScheme?: string;
      expectedProductId?: string;
      creditsPerPack?: number;
      down?: boolean;
    } = {},
  ) {
    const key = typeof hmacKey === "string" ? Buffer.from(hmacKey) : hmacKey;
    if (!key.length) throw new Error("hmac_key required");
    this.hmacKey = key;
    this.expectedPayTo = opts.expectedPayTo ?? SANDBOX_PAY_TO;
    this.expectedAmount = opts.expectedAmount ?? SANDBOX_AMOUNT;
    this.expectedAsset = opts.expectedAsset ?? SANDBOX_ASSET;
    this.expectedNetwork = opts.expectedNetwork ?? SANDBOX_NETWORK;
    this.expectedScheme = opts.expectedScheme ?? SANDBOX_SCHEME;
    this.expectedProductId = opts.expectedProductId ?? SANDBOX_PRODUCT_ID;
    this.creditsPerPack = opts.creditsPerPack ?? 1;
    this.down = opts.down === true;
  }

  markDown(): void {
    this.down = true;
  }

  markUp(): void {
    this.down = false;
  }

  isAvailable(): boolean {
    return !this.down;
  }

  private signedBody(fields: Record<string, unknown>): Record<string, unknown> {
    const required = [
      "scheme",
      "network",
      "asset",
      "amount",
      "payTo",
      "paymentIdentifier",
      "expiresAt",
      "principal",
      "site",
      "productId",
    ] as const;
    const missing = required.filter((k) => !(k in fields));
    if (missing.length) throw new InvalidProofError(`proof missing fields: ${missing.join(",")}`);
    const body: Record<string, unknown> = {};
    for (const k of required) body[k] = fields[k];
    return body;
  }

  signProof(fields: Record<string, unknown>): Record<string, unknown> {
    const body = this.signedBody(fields);
    const mac = createHmac("sha256", this.hmacKey).update(canonicalJson(body)).digest("hex");
    return { ...fields, proof: { alg: "HMAC-SHA256", mac, sandbox: true } };
  }

  verifySettlement(payload: Record<string, unknown>): VerifiedSettlement {
    const t0 = process.hrtime.bigint();
    if (!this.isAvailable()) throw new ProviderDownError();
    const proof = payload.proof;
    if (!proof || typeof proof !== "object" || !("mac" in proof) || !(proof as { mac?: unknown }).mac) {
      throw new InvalidProofError("client assertion is not server-verified settlement");
    }
    const body = this.signedBody(payload);
    const expectedMac = createHmac("sha256", this.hmacKey).update(canonicalJson(body)).digest("hex");
    const got = String((proof as { mac: unknown }).mac);
    const a = Buffer.from(got);
    const b = Buffer.from(expectedMac);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new InvalidProofError("invalid settlement MAC");
    }
    const now = Number(payload._now ?? Date.now() / 1000);
    const expiresAt = Number(payload.expiresAt);
    if (expiresAt < now) throw new InvalidProofError("expired settlement proof");
    if (payload.scheme !== this.expectedScheme) throw new InvalidProofError("wrong scheme");
    if (payload.network !== this.expectedNetwork) throw new InvalidProofError("wrong network");
    if (payload.asset !== this.expectedAsset) throw new InvalidProofError("wrong asset");
    if (String(payload.amount) !== String(this.expectedAmount)) throw new InvalidProofError("wrong amount");
    if (payload.payTo !== this.expectedPayTo) throw new InvalidProofError("wrong recipient");
    if (payload.productId !== this.expectedProductId) throw new InvalidProofError("wrong product");
    const pid = String(payload.paymentIdentifier);
    if (pid.length < 16 || pid.length > 128) throw new InvalidProofError("invalid payment-identifier length");
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    return {
      paymentIdentifier: pid,
      principal: String(payload.principal),
      site: String(payload.site),
      amount: String(payload.amount),
      asset: String(payload.asset),
      network: String(payload.network),
      payTo: String(payload.payTo),
      scheme: String(payload.scheme),
      productId: String(payload.productId),
      credits: this.creditsPerPack,
      expiresAt,
      verifiedAt: Date.now() / 1000,
      latencyMs,
    };
  }
}

export class DeployPackService {
  readonly ledger: JsonlLedger;
  readonly provider: SandboxX402ExactAdapter;
  readonly envelope: PaymentRequiredBuilder;
  freeQuota: number;
  paidThreshold: number;
  /** Nicolae 2026-09-01: fully free until cold-agent publish works without pasted tokens. */
  enforcePaywall: boolean;
  unitsPerDeploy: number;
  latencySamplesMs: number[] = [];
  private readonly operatorToken: string | undefined;

  constructor(input: {
    ledger: JsonlLedger;
    provider: SandboxX402ExactAdapter;
    envelope?: PaymentRequiredBuilder;
    freeQuota?: number;
    paidThreshold?: number;
    enforcePaywall?: boolean;
    operatorToken?: string;
    unitsPerDeploy?: number;
  }) {
    this.ledger = input.ledger;
    this.provider = input.provider;
    this.envelope = input.envelope ?? new PaymentRequiredBuilder();
    this.freeQuota = input.freeQuota ?? SANDBOX_PAID_THRESHOLD;
    this.paidThreshold = input.paidThreshold ?? SANDBOX_PAID_THRESHOLD;
    this.enforcePaywall = input.enforcePaywall === true;
    this.unitsPerDeploy = input.unitsPerDeploy ?? 1;
    this.operatorToken = input.operatorToken;
  }

  private operatorOk(token: string | undefined): boolean {
    if (!this.operatorToken || !token) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(this.operatorToken);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  fingerprintFor(principal: string, site: string): string {
    return fingerprint(
      offerFields({
        scheme: this.envelope.scheme,
        network: this.envelope.network,
        asset: this.envelope.asset,
        amount: this.envelope.amount,
        payTo: this.envelope.payTo,
        method: SANDBOX_METHOD,
        route: this.envelope.routeFor(site),
        principal,
        site,
        operation: SANDBOX_OPERATION,
      }),
    );
  }

  paymentRequired(principal: string, site: string, extra: { paymentIdentifier?: string; error?: string } = {}): PaymentRequiredResponse {
    return this.envelope.build({ principal, site, ...extra });
  }

  async settle(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.ledger.withLock(() => this.settleUnlocked(payload));
  }

  private settleUnlocked(payload: Record<string, unknown>): Record<string, unknown> {
    const t0 = process.hrtime.bigint();
    let verified: VerifiedSettlement;
    try {
      if (!this.provider.isAvailable()) throw new ProviderDownError();
      verified = this.provider.verifySettlement(payload);
    } catch (err) {
      if (err instanceof ProviderDownError) {
        return { status: 503, error: "provider_unavailable", detail: err.message };
      }
      if (err instanceof InvalidProofError) {
        return { status: 403, error: "invalid_settlement", detail: err.reason };
      }
      throw err;
    }
    const fp = this.fingerprintFor(verified.principal, verified.site);
    try {
      const event = this.ledger.creditSettlement({
        principal: verified.principal,
        site: verified.site,
        units: verified.credits,
        paymentIdentifier: verified.paymentIdentifier,
        fingerprint: fp,
        productId: verified.productId,
        extra: {
          amount: verified.amount,
          network: verified.network,
          asset: verified.asset,
          payTo: verified.payTo,
          scheme: verified.scheme,
        },
      });
      const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
      this.latencySamplesMs.push(totalMs);
      return {
        status: 200,
        credited: !event.idempotentReplay,
        idempotentReplay: event.idempotentReplay,
        units: event.units,
        balance: this.ledger.balance(verified.principal, verified.site),
        paymentIdentifier: verified.paymentIdentifier,
        settlementLatencyMs: Math.round(totalMs * 1000) / 1000,
        verifyLatencyMs: Math.round(verified.latencyMs * 1000) / 1000,
        sandbox: true,
      };
    } catch (err) {
      if (err instanceof ConflictError) {
        return { status: err.status, error: "fingerprint_conflict", detail: err.message };
      }
      throw err;
    }
  }

  async deploy(input: {
    principal: string;
    site: string;
    operatorToken?: string;
    paymentPayload?: Record<string, unknown>;
    deployId?: string;
    simulate?: DeployOutcome;
    paymentIdentifierOverride?: string;
  }): Promise<DeployResult> {
    return this.ledger.withLock(() => this.deployUnlocked(input));
  }

  private deployUnlocked(input: {
    principal: string;
    site: string;
    operatorToken?: string;
    paymentPayload?: Record<string, unknown>;
    deployId?: string;
    simulate?: DeployOutcome;
    paymentIdentifierOverride?: string;
  }): DeployResult {
    const deployId = input.deployId ?? `dpl_${randomBytes(8).toString("hex")}`;
    const state = input.simulate ?? "active";
    if (state !== "active" && state !== "failed" && state !== "partial") {
      throw new Error(`unknown simulate state: ${state}`);
    }
    const fp = this.fingerprintFor(input.principal, input.site);

    if (this.operatorOk(input.operatorToken)) {
      return {
        status: 201,
        deployId,
        state,
        billed: false,
        path: "operator-token",
        sandbox: true,
      };
    }

    if (!this.provider.isAvailable()) {
      return {
        status: 503,
        error: "provider_unavailable",
        detail: "fail closed: payment provider marked down",
      };
    }

    const existingDebit = this.ledger.findDeployDebit(deployId);
    if (existingDebit) {
      if (existingDebit.fingerprint !== fp) {
        return {
          status: 409,
          error: "fingerprint_conflict",
          detail: "deployId bound to a different fingerprint",
        };
      }
      return {
        status: 201,
        deployId,
        state: "active",
        billed: true,
        path: "paid-idempotent",
        idempotentReplay: true,
        balance: this.ledger.balance(input.principal, input.site),
        sandbox: true,
      };
    }

    const existingFree = this.ledger.findFreeDeploy(deployId);
    if (existingFree) {
      return {
        status: 201,
        deployId,
        state: "active",
        billed: false,
        path: "free-idempotent",
        idempotentReplay: true,
        sandbox: true,
      };
    }

    if (input.paymentPayload) {
      const settled = this.settleUnlocked(input.paymentPayload);
      if (settled.status !== 200) return settled as DeployResult;
    }

    const quota = this.enforcePaywall ? this.freeQuota : 1_000_000_000;
    const freeRemaining = quota - this.ledger.freeUsed(input.principal, input.site);
    if (freeRemaining >= this.unitsPerDeploy) {
      if (state !== "active") {
        return {
          status: 500,
          deployId,
          state,
          billed: false,
          path: "free",
          detail: "failed/partial deploy does not consume free quota or credit",
          sandbox: true,
        };
      }
      this.ledger.consumeFree({
        principal: input.principal,
        site: input.site,
        units: this.unitsPerDeploy,
        deployId,
        freeQuota: quota,
      });
      return {
        status: 201,
        deployId,
        state: "active",
        billed: false,
        path: "free",
        freeRemaining: quota - this.ledger.freeUsed(input.principal, input.site),
        deployMeter: this.ledger.deployMeter(input.principal, input.site),
        paidThreshold: this.paidThreshold,
        enforcePaywall: this.enforcePaywall,
        sandbox: true,
      };
    }

    if (this.ledger.balance(input.principal, input.site) >= this.unitsPerDeploy) {
      if (state !== "active") {
        return {
          status: 500,
          deployId,
          state,
          billed: false,
          path: "paid",
          balance: this.ledger.balance(input.principal, input.site),
          detail: "failed/partial deploy does not debit",
          sandbox: true,
        };
      }
      try {
        this.ledger.debitActiveDeploy({
          principal: input.principal,
          site: input.site,
          units: this.unitsPerDeploy,
          deployId,
          fingerprint: fp,
          productId: this.envelope.productId,
        });
      } catch (err) {
        if (err instanceof ConflictError) {
          return { status: err.status, error: "debit_conflict", detail: err.message };
        }
        throw err;
      }
      return {
        status: 201,
        deployId,
        state: "active",
        billed: true,
        path: "paid",
        balance: this.ledger.balance(input.principal, input.site),
        deployMeter: this.ledger.deployMeter(input.principal, input.site),
        sandbox: true,
      };
    }

    const pid = input.paymentIdentifierOverride ?? generatePaymentId();
    return this.paymentRequired(input.principal, input.site, { paymentIdentifier: pid });
  }
}

export function makeSandboxService(
  ledgerPath: string | undefined,
  hmacKey: Buffer | string,
  opts: { operatorToken?: string; enforcePaywall?: boolean; freeQuota?: number } = {},
): DeployPackService {
  const ledger = new JsonlLedger(ledgerPath);
  const provider = new SandboxX402ExactAdapter(hmacKey);
  return new DeployPackService({
    ledger,
    provider,
    operatorToken: opts.operatorToken ?? "op_sandbox_token",
    freeQuota: opts.freeQuota ?? 1,
    enforcePaywall: opts.enforcePaywall === true,
    paidThreshold: SANDBOX_PAID_THRESHOLD,
  });
}

/** Optional sandbox-only 402 helper. Never attached to POST /api/v1/sites/:slug/deploy. */
export function registerSandboxX402Routes(app: Hono, service: DeployPackService): void {
  app.get("/api/v1/sandbox/x402/payment-required", (c) => {
    const principal = c.req.query("principal") || "sandbox";
    const site = c.req.query("site") || "demo";
    const envelope = service.paymentRequired(principal, site);
    return c.json(envelope.body, 402, envelope.headers);
  });
}

export function createSandboxX402App(service: DeployPackService): Hono {
  const app = new Hono();
  registerSandboxX402Routes(app, service);
  return app;
}
