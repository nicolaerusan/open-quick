import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPromotionReceipt } from "../scripts/promotion-receipt.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/promotion-receipt.mjs");
const PIN = "70becb59a9a8bdf50ff895aec3c410b11592359b";
const DEFAULT_HOST = "https://open-quick-production.up.railway.app";

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    const child = spawn(process.execPath, [script, ...args], {
      cwd: join(dirname(script), ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}

test("buildPromotionReceipt happy handoff shape", () => {
  const receipt = buildPromotionReceipt({ pin: PIN, env: {} });
  assert.equal(receipt.schema, "openquick-promotion-receipt/v1");
  assert.equal(receipt.mode, "handoff");
  assert.equal(receipt.pin, PIN);
  assert.equal(receipt.production.host, DEFAULT_HOST);
  assert.equal(receipt.production.healthz, DEFAULT_HOST + "/healthz");
  assert.equal(receipt.production.openapi, DEFAULT_HOST + "/openapi.json");
  assert.equal(receipt.production.attestation, DEFAULT_HOST + "/.well-known/openquick-release.json");
  assert.equal(typeof receipt.gate.command, "string");
  assert.match(receipt.gate.command, /gate:promotion/);
  assert.match(receipt.gate.command, new RegExp(PIN));
  assert.equal(receipt.gate.exit, null);
  assert.equal(receipt.gate.buildStatus, null);
  assert.equal(receipt.gate.testStatus, null);
  assert.equal(receipt.deployment.id, null);
  assert.equal(receipt.deployment.deployedAt, null);
  assert.equal(receipt.deployment.sourceRevisionEnv, "OPENQUICK_SOURCE_REVISION");
  assert.equal(receipt.deployment.builtAtEnv, "OPENQUICK_BUILT_AT");
  assert.equal(receipt.deployment.deploymentIdEnv, "OPENQUICK_DEPLOYMENT_ID");
  assert.equal(receipt.verification.status, null);
  assert.equal(receipt.verification.checkedAt, null);
  assert.equal(receipt.boundaries.gateTask, 127);
  assert.equal(receipt.boundaries.workflowTask, 100);
  assert.equal(receipt.boundaries.railwayHarnessTask, 106);
  assert.equal(receipt.boundaries.contentProbeTask, 90);
  assert.equal(receipt.boundaries.credentials, "never_in_receipt_or_commons");
  assert.equal(receipt.operatorHandoff.pin, PIN);
  assert.ok(Array.isArray(receipt.operatorHandoff.steps));
  assert.ok(receipt.operatorHandoff.steps.length >= 3);
  assert.ok(receipt.operatorHandoff.steps.some((step) => step.includes("gate:promotion")));
  assert.ok(Array.isArray(receipt.operatorHandoff.fillIn));
  assert.ok(receipt.operatorHandoff.fillIn.includes("deployment.id"));
  const blob = JSON.stringify(receipt);
  assert.doesNotMatch(blob, /RAILWAY_TOKEN|OPENQUICK_TOKEN|COMMONS_KEY|Bearer |sk_/);
});

test("buildPromotionReceipt missing and invalid pin throws", () => {
  assert.throws(() => buildPromotionReceipt({ env: {} }), /missing pin/);
  assert.throws(() => buildPromotionReceipt({ pin: "not-a-sha", env: {} }), /invalid pin/);
  assert.throws(() => buildPromotionReceipt({ pin: PIN.toUpperCase(), env: {} }), /invalid pin/);
});

test("buildPromotionReceipt promoted without deploymentId throws", () => {
  assert.throws(
    () => buildPromotionReceipt({
      pin: PIN,
      mode: "promoted",
      deployedAt: "2026-09-01T12:00:00Z",
      env: {},
    }),
    /promoted mode requires deploymentId/,
  );
});

test("buildPromotionReceipt credential-shaped deploymentId throws", () => {
  assert.throws(
    () => buildPromotionReceipt({
      pin: PIN,
      deploymentId: 'sk_test_not_a_real_secret_value',
      env: {},
    }),
    /credential-shaped value refused for deploymentId/,
  );
});

test("CLI missing --pin exits 2", async () => {
  const missing = await run([]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /usage|missing --pin/);
  assert.doesNotMatch(missing.stderr, /RAILWAY_TOKEN|OPENQUICK_TOKEN|COMMONS_KEY|process\.env/);
});

test("CLI handoff prints schema and pin", async () => {
  const result = await run(["--pin", PIN]);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schema, "openquick-promotion-receipt/v1");
  assert.equal(receipt.pin, PIN);
  assert.equal(receipt.mode, "handoff");
  assert.equal(receipt.operatorHandoff.pin, PIN);
  assert.doesNotMatch(result.stdout + result.stderr, /RAILWAY_TOKEN|OPENQUICK_TOKEN|COMMONS_KEY|process\.env/);
});

test("CLI refuses sk_ token as --deployment-id", async () => {
  const result = await run(["--pin", PIN, "--deployment-id", 'sk_test_not_a_real_secret_value']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /credential-shaped/);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /RAILWAY_TOKEN|OPENQUICK_TOKEN|COMMONS_KEY|process\.env/);
});
