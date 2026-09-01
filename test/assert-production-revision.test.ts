import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/assert-production-revision.mjs");
const SHA = "d91882294951c432689671d7da4908c70721438d";
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function run(args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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

test("assert script exits 0 when sourceRevision matches", async () => {
  await withServer((req, res) => {
    assert.equal(req.url, "/.well-known/openquick-release.json");
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      schema: "openquick-release/v1",
      service: "openquick",
      sourceRevision: SHA,
      builtAt: "2026-09-01T12:00:00Z",
      deploymentId: "dep-1",
    }));
  }, async (origin) => {
    const result = await run(["--host", origin, "--expect", SHA]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
  });
});

test("assert script fails closed on HTTP error schema miss or mismatch", async () => {
  const missing = await run(["--host", "https://example.invalid", "--expect", SHA]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /attestation fetch failed|ENOTFOUND|unavailable/);

  await withServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }, async (origin) => {
    const result = await run(["--host", origin, "--expect", SHA]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /HTTP 404/);
    assert.doesNotMatch(result.stderr, /RAILWAY|TOKEN|process\.env/);
  });

  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      schema: "openquick-release/v1",
      service: "openquick",
      sourceRevision: OTHER,
      builtAt: "2026-09-01T12:00:00Z",
      deploymentId: "dep-1",
    }));
  }, async (origin) => {
    const result = await run(["--host", origin, "--expect", SHA]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /attestation mismatch/);
  });
});
