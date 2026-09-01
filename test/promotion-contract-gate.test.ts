import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/promotion-contract-gate.mjs");
const PIN = "70becb59a9a8bdf50ff895aec3c410b11592359b";
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function run(args: string[], cwd?: string): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function openapiWithDeploy(includeDeploy: boolean) {
  const deploy = includeDeploy
    ? {
      post: {
        responses: {
          "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/DeployReceipt" } } } },
          "401": { content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          "413": { content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          "422": { content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
        },
      },
    }
    : { post: { responses: { "201": { description: "created" } } } };
  return {
    openapi: "3.1.0",
    paths: {
      "/api/v1/sites/{slug}/deploy": deploy,
      "/healthz": { get: { responses: { "200": { description: "ok" } } } },
      "/api/v1/sites": { get: { responses: { "200": { description: "list" } } } },
      "/api/v1/sites/{slug}": { get: { responses: { "200": { description: "detail" } } } },
    },
    components: {
      schemas: {
        DeployReceipt: { type: "object", properties: { site: {}, url: { type: "string" } } },
        ErrorEnvelope: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  };
}

function mockHandler(opts: { deploy: boolean; attestation: "404" | "ok" }) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(openapiWithDeploy(opts.deploy)));
      return;
    }
    if (req.url === "/.well-known/openquick-release.json") {
      if (opts.attestation === "404") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        schema: "openquick-release/v1",
        service: "openquick",
        sourceRevision: PIN,
        builtAt: "2026-09-01T12:00:00Z",
        deploymentId: "dep-1",
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  };
}

test("promotion gate exits 2 on usage and invalid pin", async () => {
  const missing = await run([]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /usage|missing --pin/);

  const bad = await run(["--pin", "not-a-sha", "--build-only"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /invalid --pin/);
  assert.doesNotMatch(missing.stderr + bad.stderr, /RAILWAY|TOKEN|process\.env/);
});

test("promotion gate fails closed on HEAD mismatch", async () => {
  const result = await run(["--pin", OTHER, "--build-only", "--skip-install", "--allow-dirty"], join(dirname(script), ".."));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HEAD mismatch/);
  assert.doesNotMatch(result.stderr, /RAILWAY|TOKEN|process\.env/);
});

test("live-only passes when deploy schemas present", async () => {
  await withServer(mockHandler({ deploy: true, attestation: "404" }), async (origin) => {
    const result = await run(["--live-only", "--pin", PIN, "--host", origin]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /attestation unavailable: HTTP 404/);
    assert.doesNotMatch(result.stderr, /RAILWAY|TOKEN|process\.env/);
  });
});

test("live-only fails when deploy schemas missing", async () => {
  await withServer(mockHandler({ deploy: false, attestation: "404" }), async (origin) => {
    const result = await run(["--live-only", "--pin", PIN, "--host", origin]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /deploy OpenAPI miss/);
    assert.doesNotMatch(result.stderr, /RAILWAY|TOKEN|process\.env/);
  });
});

test("attestation 404 is soft unless --require-attestation", async () => {
  await withServer(mockHandler({ deploy: true, attestation: "404" }), async (origin) => {
    const soft = await run(["--live-only", "--pin", PIN, "--host", origin]);
    assert.equal(soft.code, 0, soft.stderr);
    assert.match(soft.stderr, /attestation unavailable: HTTP 404/);

    const hard = await run(["--live-only", "--pin", PIN, "--host", origin, "--require-attestation"]);
    assert.equal(hard.code, 1);
    assert.match(hard.stderr, /attestation required but HTTP 404/);
    assert.doesNotMatch(soft.stderr + hard.stderr, /RAILWAY|TOKEN|process\.env/);
  });
});
