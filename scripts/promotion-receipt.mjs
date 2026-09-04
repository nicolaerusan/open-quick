/**
 * Privacy-safe Space-main to Railway promotion receipt emitter.
 * Complements scripts/promotion-contract-gate.mjs (#127).
 * Does not call the Railway API or carry credentials (harness is #106).
 * Never dumps environment or secrets.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const PROMOTION_RECEIPT_SCHEMA = "openquick-promotion-receipt/v1";
export const DEFAULT_HOST = "https://open-quick-production.up.railway.app";

const SOURCE_REVISION = /^[0-9a-f]{40}$/;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const DEPLOYMENT_ID = /^\S{1,256}$/;
const GATE_EXITS = new Set([0, 1, 2]);
const MODES = new Set(["handoff", "promoted"]);

const FORBIDDEN_ENV_NAMES = [
  "RAILWAY_TOKEN",
  "RAILWAY_API_TOKEN",
  "RAILWAY_PROJECT_TOKEN",
  "OPENQUICK_TOKEN",
  "OPENQUICK_ADMIN_TOKEN",
  "COMMONS_KEY",
  "COMMONS_TOKEN",
  "COMMONS_API_KEY",
  "COMMONS_CONNECTION",
];

const ALLOWED_OPTIONAL_ENV = new Set(["OPENQUICK_DEPLOYMENT_ID", "OPENQUICK_BUILT_AT"]);

const CREDENTIAL_SHAPED =
  /(?:^|[\s="'`:])(?:sk_|rk_|pk_live_|pk_test_|Bearer\b|Basic\b|eyJ[A-Za-z0-9_-]{8,}\.|ghp_|gho_|github_pat_|xox[baprs]-)/i;

export class PromotionReceiptError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "PromotionReceiptError";
    this.exitCode = options.exitCode ?? 1;
  }
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function usage(message) {
  if (message) console.error(message);
  console.error(
    "usage: promotion-receipt --pin <40-char-sha> [--host <origin>] " +
      "[--mode handoff|promoted] [--gate-exit 0|1|2] [--build-status <status>] " +
      "[--test-status <status>] [--verification-status <status>] " +
      "[--deployment-id <id>] [--deployed-at <RFC3339>] [--out <path>] [--pretty]",
  );
  process.exit(2);
}

function fail(reason, code = 1) {
  console.error(reason);
  process.exit(code);
}

function present(value) {
  return typeof value === "string" && value.length > 0;
}

export function isCredentialShaped(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (CREDENTIAL_SHAPED.test(value)) return true;
  if (/authorization\s*[:=]/i.test(value) && /bearer|basic|token/i.test(value)) return true;
  return false;
}


function isRfc3339Utc(value) {
  const match = RFC3339_UTC.exec(value);
  if (!match) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

function refuseCredential(value, label) {
  if (typeof value !== "string" || value.length === 0) return;
  if (isCredentialShaped(value)) {
    throw new PromotionReceiptError(`credential-shaped value refused for ${label}`, { exitCode: 1 });
  }
}

function optionalSafeEnv(env, name) {
  const value = env?.[name];
  if (!present(value)) return undefined;
  if (isCredentialShaped(value)) return undefined;
  return value;
}

function assertNoForbiddenLeak(receipt, env) {
  const serialized = JSON.stringify(receipt);
  if (isCredentialShaped(serialized)) {
    throw new PromotionReceiptError("refusing to emit: credential-shaped material in receipt", { exitCode: 1 });
  }
  if (!env) return;
  for (const [name, value] of Object.entries(env)) {
    if (!present(value) || value.length < 8) continue;
    if (ALLOWED_OPTIONAL_ENV.has(name)) continue;
    const forbiddenName = FORBIDDEN_ENV_NAMES.includes(name)
      || /(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY)$/i.test(name);
    if (forbiddenName && serialized.includes(value)) {
      throw new PromotionReceiptError(
        "refusing to emit: forbidden environment value would leak into receipt",
        { exitCode: 1 },
      );
    }
  }
}

function productionUrls(host) {
  let origin;
  try {
    origin = new URL(host).origin;
  } catch {
    throw new PromotionReceiptError("invalid host: need an absolute http(s) origin", { exitCode: 2 });
  }
  const protocol = new URL(origin).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new PromotionReceiptError("invalid host: need an absolute http(s) origin", { exitCode: 2 });
  }
  return {
    host: origin,
    healthz: `${origin}/healthz`,
    openapi: `${origin}/openapi.json`,
    attestation: `${origin}/.well-known/openquick-release.json`,
  };
}

function operatorHandoff(pin, origin) {
  const buildGate = 'npm run gate:promotion' + " -- --pin " + pin + " --build-only";
  const liveGate = 'npm run gate:promotion' + " -- --live-only --pin " + pin + " --host " + origin + " --require-attestation";
  const emitPromoted = 'npm run receipt:promotion' + " -- --mode promoted --pin " + pin + " --host " + origin + " --deployment-id <opaque-id> --deployed-at <RFC3339 UTC> --gate-exit 0";
  return {
    pin,
    steps: [
      "On a clean checkout of Space-main at " + pin + ", run the promotion contract gate (#127): " + buildGate,
      "In Railway (operator credentials only; never paste into Commons or this receipt), deploy that exact commit and set at build: OPENQUICK_SOURCE_REVISION=" + pin + ", OPENQUICK_BUILT_AT=<RFC3339 UTC>, OPENQUICK_DEPLOYMENT_ID=<opaque Railway deployment id>. Do not fall back to RAILWAY_GIT_COMMIT_SHA. Railway API/auth belongs to task #106, not this emitter.",
      "After deploy, re-run the live gate: " + liveGate,
      "Emit a promoted receipt: " + emitPromoted,
      "Record the Railway deployment id, checked timestamp, healthz, OpenAPI, and attestation evidence on Commons. Do not publish credentials.",
    ],
    fillIn: [
      "deployment.id",
      "deployment.deployedAt",
      "OPENQUICK_BUILT_AT",
      "OPENQUICK_DEPLOYMENT_ID",
      "gate.exit",
      "gate.buildStatus",
      "gate.testStatus",
      "verification.status",
      "verification.checkedAt",
    ],
  };
}


export function buildPromotionReceipt(input = {}) {
  const env = input.env ?? process.env;
  const mode = present(input.mode) ? input.mode : "handoff";
  if (!MODES.has(mode)) {
    throw new PromotionReceiptError("invalid mode: need handoff or promoted", { exitCode: 2 });
  }

  const pin = input.pin;
  if (!present(pin)) {
    throw new PromotionReceiptError("missing pin", { exitCode: 2 });
  }
  if (!SOURCE_REVISION.test(pin)) {
    throw new PromotionReceiptError("invalid pin: need a 40-character lowercase git SHA", { exitCode: 2 });
  }

  const host = present(input.host) ? input.host : DEFAULT_HOST;
  refuseCredential(host, "host");
  const production = productionUrls(host);

  const deploymentId = present(input.deploymentId)
    ? input.deploymentId
    : (optionalSafeEnv(env, "OPENQUICK_DEPLOYMENT_ID") ?? null);
  const deployedAt = present(input.deployedAt)
    ? input.deployedAt
    : (optionalSafeEnv(env, "OPENQUICK_BUILT_AT") ?? null);

  refuseCredential(pin, "pin");
  refuseCredential(mode, "mode");
  refuseCredential(deploymentId, "deploymentId");
  refuseCredential(deployedAt, "deployedAt");
  refuseCredential(input.buildStatus, "buildStatus");
  refuseCredential(input.testStatus, "testStatus");
  refuseCredential(input.verificationStatus, "verificationStatus");

  if (deploymentId !== null && !DEPLOYMENT_ID.test(deploymentId)) {
    throw new PromotionReceiptError(
      "invalid deploymentId: need a non-empty opaque id without whitespace",
      { exitCode: 1 },
    );
  }
  if (deployedAt !== null && !isRfc3339Utc(deployedAt)) {
    throw new PromotionReceiptError("invalid deployedAt: need an RFC 3339 UTC timestamp", { exitCode: 1 });
  }

  if (mode === "promoted") {
    if (!present(deploymentId)) {
      throw new PromotionReceiptError("promoted mode requires deploymentId", { exitCode: 1 });
    }
    if (!present(deployedAt)) {
      throw new PromotionReceiptError("promoted mode requires deployedAt", { exitCode: 1 });
    }
  }

  let gateExit = null;
  if (input.gateExit !== undefined && input.gateExit !== null && input.gateExit !== "") {
    const parsed = typeof input.gateExit === "number" ? input.gateExit : Number(input.gateExit);
    if (!Number.isInteger(parsed) || !GATE_EXITS.has(parsed)) {
      throw new PromotionReceiptError("invalid gateExit: need 0, 1, or 2", { exitCode: 2 });
    }
    gateExit = parsed;
  }

  const buildStatus = present(input.buildStatus) ? input.buildStatus : null;
  const testStatus = present(input.testStatus) ? input.testStatus : null;
  const verificationStatus = present(input.verificationStatus) ? input.verificationStatus : null;
  const checkedAt = verificationStatus ? new Date().toISOString() : null;

  const receipt = {
    schema: PROMOTION_RECEIPT_SCHEMA,
    mode,
    pin,
    production,
    gate: {
      command: 'npm run gate:promotion -- --pin ' + pin + " --host " + production.host,
      exit: gateExit,
      buildStatus,
      testStatus,
    },
    deployment: {
      id: deploymentId,
      deployedAt,
      sourceRevisionEnv: "OPENQUICK_SOURCE_REVISION",
      builtAtEnv: "OPENQUICK_BUILT_AT",
      deploymentIdEnv: "OPENQUICK_DEPLOYMENT_ID",
    },
    verification: {
      status: verificationStatus,
      checkedAt,
    },
    boundaries: {
      gateTask: 127,
      workflowTask: 100,
      railwayHarnessTask: 106,
      contentProbeTask: 90,
      credentials: "never_in_receipt_or_commons",
    },
  };

  if (mode === "handoff") {
    receipt.operatorHandoff = operatorHandoff(pin, production.host);
  }

  assertNoForbiddenLeak(receipt, env);
  return receipt;
}


export async function main(argv = process.argv.slice(2)) {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) usage();

  const pin = argValue(argv, "--pin");
  if (!pin) usage("missing --pin");
  if (!SOURCE_REVISION.test(pin)) usage("invalid --pin: need a 40-character lowercase git SHA");

  const mode = argValue(argv, "--mode") ?? "handoff";
  if (!MODES.has(mode)) usage("invalid --mode: need handoff or promoted");

  const host = argValue(argv, "--host") ?? DEFAULT_HOST;
  const gateExitArg = argValue(argv, "--gate-exit");
  if (hasFlag(argv, "--gate-exit") && gateExitArg === undefined) usage("missing --gate-exit value");
  if (gateExitArg !== undefined && !["0", "1", "2"].includes(gateExitArg)) {
    usage("invalid --gate-exit: need 0, 1, or 2");
  }

  const out = argValue(argv, "--out");
  if (hasFlag(argv, "--out") && !present(out)) usage("missing --out path");
  const pretty = hasFlag(argv, "--pretty");

  const deploymentId = argValue(argv, "--deployment-id");
  const deployedAt = argValue(argv, "--deployed-at");
  const buildStatus = argValue(argv, "--build-status");
  const testStatus = argValue(argv, "--test-status");
  const verificationStatus = argValue(argv, "--verification-status");

  if (mode === "promoted") {
    if (!present(deploymentId) && !present(process.env.OPENQUICK_DEPLOYMENT_ID)) {
      usage("promoted mode requires --deployment-id");
    }
    if (!present(deployedAt) && !present(process.env.OPENQUICK_BUILT_AT)) {
      usage("promoted mode requires --deployed-at");
    }
  }

  let receipt;
  try {
    receipt = buildPromotionReceipt({
      pin,
      host,
      mode,
      gateExit: gateExitArg,
      buildStatus,
      testStatus,
      verificationStatus,
      deploymentId,
      deployedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof PromotionReceiptError ? error.exitCode : 1;
    if (code === 2) usage(message);
    fail(message, code);
  }

  const json = pretty ? `${JSON.stringify(receipt, null, 2)}\n` : `${JSON.stringify(receipt)}\n`;
  if (out) {
    try {
      await writeFile(resolve(out), json, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`failed to write --out: ${message}`);
    }
  } else {
    process.stdout.write(json);
  }
  process.exit(0);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const isDirect = entry.endsWith("/promotion-receipt.mjs") || entry.endsWith("/promotion-receipt");
if (isDirect) await main();
