/**
 * Space-main to Railway promotion contract gate for OpenQuick.
 * Fail-closed pin/build/live OpenAPI contract checks.
 * Never dumps environment or credentials.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE_REVISION = /^[0-9a-f]{40}$/;
const ATTESTATION_SCHEMA = "openquick-release/v1";
const DEPLOY_PATH = "/api/v1/sites/{slug}/deploy";
const PUBLIC_READ_CHECKS = [
  { path: "/healthz", method: "get", status: "200" },
  { path: "/api/v1/sites", method: "get", status: "200" },
  { path: "/api/v1/sites/{slug}", method: "get", status: "200" },
];
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
    "usage: promotion-contract-gate --pin <40-char-sha> [--host <origin>] " +
      "[--build-only|--live-only] [--allow-dirty] [--skip-install] [--repo-root <path>] " +
      "[--require-attestation] [--require-public-read] [--require-release-url]",
  );
  process.exit(2);
}

function fail(reason, code = 1) {
  console.error(reason);
  process.exit(code);
}

function note(message) {
  console.error(`note: ${message}`);
}

function runCommand(command, args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
      shell: false,
    });
    child.on("error", (error) => {
      console.error(`${command} failed to start: ${error.message}`);
      resolvePromise(1);
    });
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

function runCapture(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

function responseSchemaRef(document, path, method, status) {
  const item = document?.paths?.[path];
  const op = item?.[method];
  return op?.responses?.[status]?.content?.["application/json"]?.schema?.$ref;
}

export async function checkProductionContract(origin, pin, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const notes = [];
  const errors = [];

  let healthResponse;
  try {
    healthResponse = await fetchImpl(`${origin}/healthz`, {
      redirect: "error",
      headers: { accept: "application/json" },
    });
  } catch {
    errors.push(`healthz fetch failed for ${origin}/healthz`);
    return { ok: false, notes, errors };
  }
  if (!healthResponse.ok) {
    errors.push(`healthz unavailable: HTTP ${healthResponse.status}`);
  } else {
    let healthBody;
    try { healthBody = await healthResponse.json(); }
    catch {
      errors.push("healthz schema miss: response is not JSON");
      healthBody = undefined;
    }
    if (healthBody !== undefined) {
      if (!healthBody || typeof healthBody !== "object" || Array.isArray(healthBody) || healthBody.ok !== true) {
        errors.push("healthz contract miss: expected {ok:true}");
      }
    }
  }

  let openapiResponse;
  try {
    openapiResponse = await fetchImpl(`${origin}/openapi.json`, {
      redirect: "error",
      headers: { accept: "application/json" },
    });
  } catch {
    errors.push(`openapi fetch failed for ${origin}/openapi.json`);
    return { ok: false, notes, errors };
  }
  if (!openapiResponse.ok) {
    errors.push(`openapi unavailable: HTTP ${openapiResponse.status}`);
    return { ok: false, notes, errors };
  }

  let document;
  try { document = await openapiResponse.json(); }
  catch {
    errors.push("openapi schema miss: response is not JSON");
    return { ok: false, notes, errors };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    errors.push("openapi schema miss: response is not an object");
    return { ok: false, notes, errors };
  }

  const deploy201 = responseSchemaRef(document, DEPLOY_PATH, "post", "201");
  if (deploy201 !== "#/components/schemas/DeployReceipt") {
    errors.push("deploy OpenAPI miss: 201 must $ref DeployReceipt");
  }
  for (const status of ["401", "413", "422"]) {
    const ref = responseSchemaRef(document, DEPLOY_PATH, "post", status);
    if (ref !== "#/components/schemas/ErrorEnvelope") {
      errors.push(`deploy OpenAPI miss: ${status} must $ref ErrorEnvelope`);
    }
  }

  const receiptSchema = document.components?.schemas?.DeployReceipt;
  const hasReleaseUrl =
    !!receiptSchema && typeof receiptSchema === "object" && !Array.isArray(receiptSchema) &&
    !!receiptSchema.properties?.releaseUrl;
  if (hasReleaseUrl) notes.push("DeployReceipt.releaseUrl present");
  else {
    notes.push("DeployReceipt.releaseUrl absent");
    if (options.requireReleaseUrl) errors.push("DeployReceipt.releaseUrl required but missing");
  }

  const missingPublicRead = [];
  for (const check of PUBLIC_READ_CHECKS) {
    const ref = responseSchemaRef(document, check.path, check.method, check.status);
    if (typeof ref !== "string" || !ref.startsWith("#/components/schemas/")) {
      missingPublicRead.push(`${check.method.toUpperCase()} ${check.path} ${check.status}`);
    }
  }
  if (missingPublicRead.length === 0) {
    notes.push("public-read OpenAPI $refs present for /healthz, /api/v1/sites, /api/v1/sites/{slug}");
  } else {
    notes.push(`public-read OpenAPI $refs missing: ${missingPublicRead.join(", ")}`);
    if (options.requirePublicRead) {
      errors.push(`public-read OpenAPI $refs required but missing: ${missingPublicRead.join(", ")}`);
    }
  }

  const attestationUrl = `${origin}/.well-known/openquick-release.json`;
  let attestationResponse;
  try {
    attestationResponse = await fetchImpl(attestationUrl, {
      redirect: "error",
      headers: { accept: "application/json" },
    });
  } catch {
    errors.push(`attestation fetch failed for ${attestationUrl}`);
    return { ok: errors.length === 0, notes, errors };
  }

  if (attestationResponse.status === 404) {
    notes.push("attestation unavailable: HTTP 404");
    if (options.requireAttestation) errors.push("attestation required but HTTP 404");
  } else if (!attestationResponse.ok) {
    errors.push(`attestation unavailable: HTTP ${attestationResponse.status}`);
  } else {
    const cacheControl = attestationResponse.headers.get("cache-control") ?? "";
    if (!cacheControl.toLowerCase().includes("no-store")) {
      errors.push("attestation schema miss: Cache-Control is not no-store");
    }
    let body;
    try { body = await attestationResponse.json(); }
    catch {
      errors.push("attestation schema miss: response is not JSON");
      body = undefined;
    }
    if (body !== undefined) {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        errors.push("attestation schema miss: response is not an object");
      } else if (body.schema !== ATTESTATION_SCHEMA) {
        errors.push("attestation schema miss: schema is not openquick-release/v1");
      } else if (body.service !== "openquick") {
        errors.push("attestation schema miss: service is not openquick");
      } else if (typeof body.sourceRevision !== "string" || !SOURCE_REVISION.test(body.sourceRevision)) {
        errors.push("attestation schema miss: sourceRevision is not a 40-character lowercase git SHA");
      } else if (body.sourceRevision !== pin) {
        errors.push(`attestation mismatch: got ${body.sourceRevision} expected ${pin}`);
      } else {
        notes.push(`attestation matches pin ${pin}`);
      }
    }
  }

  return { ok: errors.length === 0, notes, errors };
}

async function verifyBuildPath(repoRoot, pin, { allowDirty, skipInstall }) {
  const head = await runCapture("git", ["rev-parse", "HEAD"], repoRoot);
  if (head.code !== 0) fail(`git rev-parse failed: ${head.stderr.trim() || "unknown error"}`);
  const headSha = head.stdout.trim().toLowerCase();
  if (!SOURCE_REVISION.test(headSha)) fail(`git HEAD is not a 40-character lowercase SHA: ${headSha}`);
  if (headSha !== pin) fail(`HEAD mismatch: got ${headSha} expected ${pin}`);

  const dirty = await runCapture("git", ["status", "--porcelain"], repoRoot);
  if (dirty.code !== 0) fail(`git status failed: ${dirty.stderr.trim() || "unknown error"}`);
  if (dirty.stdout.trim() && !allowDirty) fail("dirty worktree refused (pass --allow-dirty to override)");

  if (!skipInstall) {
    const installCode = await runCommand("npm", ["ci"], repoRoot);
    if (installCode !== 0) fail("dependency install failed");
  }

  const checks = [
    ["typecheck", ["run", "typecheck"]],
    ["test", ["test"]],
    ["build", ["run", "build"]],
  ];
  for (const [label, args] of checks) {
    const code = await runCommand("npm", args, repoRoot);
    if (code !== 0) fail(`local check failed: ${label}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) usage();

  const pin = argValue(argv, "--pin");
  if (!pin) usage("missing --pin");
  if (!SOURCE_REVISION.test(pin)) usage("invalid --pin: need a 40-character lowercase git SHA");

  const buildOnly = hasFlag(argv, "--build-only");
  const liveOnly = hasFlag(argv, "--live-only");
  if (buildOnly && liveOnly) usage("choose at most one of --build-only or --live-only");

  const host = argValue(argv, "--host");
  const allowDirty = hasFlag(argv, "--allow-dirty");
  const skipInstall = hasFlag(argv, "--skip-install");
  const requireAttestation = hasFlag(argv, "--require-attestation");
  const requirePublicRead = hasFlag(argv, "--require-public-read");
  const requireReleaseUrl = hasFlag(argv, "--require-release-url");
  const repoRootArg = argValue(argv, "--repo-root");
  const repoRoot = resolve(repoRootArg ?? process.cwd());

  if (!existsSync(repoRoot)) usage(`--repo-root does not exist: ${repoRoot}`);

  const runBuild = !liveOnly;
  const runLive = !buildOnly;
  if (runLive && !host) usage("missing --host (required unless --build-only)");

  if (runBuild) await verifyBuildPath(repoRoot, pin, { allowDirty, skipInstall });

  if (runLive) {
    let origin;
    try { origin = new URL(host).origin; }
    catch { usage("invalid --host: need an absolute http(s) origin"); }
    const result = await checkProductionContract(origin, pin, {
      requireAttestation, requirePublicRead, requireReleaseUrl,
    });
    for (const message of result.notes) note(message);
    if (!result.ok) {
      for (const message of result.errors) console.error(message);
      process.exit(1);
    }
  }

  process.exit(0);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const isDirect = entry.endsWith("/promotion-contract-gate.mjs") || entry.endsWith("/promotion-contract-gate");
if (isDirect) await main();
