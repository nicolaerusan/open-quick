#!/usr/bin/env node
/**
 * Post-deploy assertion for OpenQuick task #99.
 * Exit 0 only when GET {host}/.well-known/openquick-release.json
 * attests sourceRevision === --expect.
 * Never dumps environment or credentials.
 */
const SOURCE_REVISION = /^[0-9a-f]{40}$/;
const SCHEMA = "openquick-release/v1";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function fail(reason, code = 1) {
  console.error(reason);
  process.exit(code);
}

const host = arg("--host");
const expect = arg("--expect");
if (!host || !expect) {
  fail("usage: assert-production-revision --host <origin> --expect <40-char-sha>", 2);
}
if (!SOURCE_REVISION.test(expect)) {
  fail("invalid --expect: need a 40-character lowercase git SHA", 2);
}

let origin;
try {
  origin = new URL(host).origin;
} catch {
  fail("invalid --host: need an absolute http(s) origin", 2);
}

const url = `${origin}/.well-known/openquick-release.json`;

let response;
try {
  response = await fetch(url, { redirect: "error", headers: { accept: "application/json" } });
} catch {
  fail(`attestation fetch failed for ${url}`);
}

if (!response.ok) {
  fail(`attestation unavailable: HTTP ${response.status}`);
}

const cacheControl = response.headers.get("cache-control") ?? "";
if (!cacheControl.toLowerCase().includes("no-store")) {
  fail("attestation schema miss: Cache-Control is not no-store");
}

let body;
try {
  body = await response.json();
} catch {
  fail("attestation schema miss: response is not JSON");
}

if (!body || typeof body !== "object" || Array.isArray(body)) {
  fail("attestation schema miss: response is not an object");
}
if (body.schema !== SCHEMA) {
  fail("attestation schema miss: schema is not openquick-release/v1");
}
if (body.service !== "openquick") {
  fail("attestation schema miss: service is not openquick");
}
if (typeof body.sourceRevision !== "string" || !SOURCE_REVISION.test(body.sourceRevision)) {
  fail("attestation schema miss: sourceRevision is not a 40-character lowercase git SHA");
}
if (body.sourceRevision !== expect) {
  fail(`attestation mismatch: got ${body.sourceRevision} expected ${expect}`);
}

process.exit(0);
