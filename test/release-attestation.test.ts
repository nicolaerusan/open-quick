import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
import { loadBootConfig } from "../src/boot.js";
import {
  AttestationError,
  parseReleaseAttestation,
  resolveReleaseAttestation,
  type OpenQuickRelease,
} from "../src/release-attestation.js";
import { SiteStore } from "../src/store.js";

const PINNED: OpenQuickRelease = {
  schema: "openquick-release/v1",
  service: "openquick",
  sourceRevision: "d91882294951c432689671d7da4908c70721438d",
  builtAt: "2026-09-01T12:00:00Z",
  deploymentId: "railway-deploy-example",
};

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function appWith(attestation?: OpenQuickRelease) {
  const root = await mkdtemp(join(tmpdir(), "openquick-attestation-"));
  roots.push(root);
  const store = new SiteStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  return createApp({
    store,
    activations,
    adminToken: "test-token",
    baseUrl: "https://openquick.test",
    ...(attestation ? { attestation } : {}),
  });
}

test("parseReleaseAttestation accepts a privacy-safe v1 payload", () => {
  assert.deepEqual(parseReleaseAttestation({
    sourceRevision: PINNED.sourceRevision,
    builtAt: PINNED.builtAt,
    deploymentId: PINNED.deploymentId,
  }), PINNED);
});

test("parseReleaseAttestation rejects missing malformed and inconsistent fields", () => {
  assert.throws(() => parseReleaseAttestation({}), AttestationError);
  assert.throws(() => parseReleaseAttestation({
    sourceRevision: "D91882294951C432689671D7DA4908C70721438D",
    builtAt: PINNED.builtAt,
    deploymentId: PINNED.deploymentId,
  }), /40-character lowercase/);
  assert.throws(() => parseReleaseAttestation({
    sourceRevision: "not-a-sha",
    builtAt: PINNED.builtAt,
    deploymentId: PINNED.deploymentId,
  }), AttestationError);
  assert.throws(() => parseReleaseAttestation({
    sourceRevision: PINNED.sourceRevision,
    builtAt: "2026-09-01 12:00:00",
    deploymentId: PINNED.deploymentId,
  }), /RFC 3339 UTC/);
  assert.throws(() => parseReleaseAttestation({
    sourceRevision: PINNED.sourceRevision,
    builtAt: "2026-02-31T00:00:00Z",
    deploymentId: PINNED.deploymentId,
  }), AttestationError);
  assert.throws(() => parseReleaseAttestation({
    sourceRevision: PINNED.sourceRevision,
    builtAt: PINNED.builtAt,
    deploymentId: "has space",
  }), /without whitespace/);
  assert.throws(() => parseReleaseAttestation({
    sourceRevision: `${PINNED.sourceRevision} `,
    builtAt: PINNED.builtAt,
    deploymentId: PINNED.deploymentId,
  }), AttestationError);
});

test("resolveReleaseAttestation omits the endpoint in non-production when metadata is absent", () => {
  assert.equal(resolveReleaseAttestation({ NODE_ENV: "development" }), undefined);
  assert.equal(resolveReleaseAttestation({}), undefined);
});

test("resolveReleaseAttestation fails closed in production and never falls back to Railway git SHA", () => {
  assert.throws(() => resolveReleaseAttestation({
    NODE_ENV: "production",
    RAILWAY_GIT_COMMIT_SHA: PINNED.sourceRevision,
  }), AttestationError);
  assert.throws(() => resolveReleaseAttestation({ NODE_ENV: "production" }), /OPENQUICK_SOURCE_REVISION is required/);
  assert.throws(() => resolveReleaseAttestation({
    NODE_ENV: "production",
    OPENQUICK_SOURCE_REVISION: PINNED.sourceRevision,
  }), /OPENQUICK_BUILT_AT is required/);
  assert.deepEqual(resolveReleaseAttestation({
    NODE_ENV: "production",
    OPENQUICK_SOURCE_REVISION: PINNED.sourceRevision,
    OPENQUICK_BUILT_AT: PINNED.builtAt,
    OPENQUICK_DEPLOYMENT_ID: PINNED.deploymentId,
  }), PINNED);
});

test("loadBootConfig refuses to boot production without attestation", () => {
  assert.throws(() => loadBootConfig({
    NODE_ENV: "production",
    OPENQUICK_ADMIN_TOKEN: "prod-token",
  }), AttestationError);
  const ok = loadBootConfig({
    NODE_ENV: "production",
    OPENQUICK_ADMIN_TOKEN: "prod-token",
    OPENQUICK_SOURCE_REVISION: PINNED.sourceRevision,
    OPENQUICK_BUILT_AT: PINNED.builtAt,
    OPENQUICK_DEPLOYMENT_ID: PINNED.deploymentId,
  });
  assert.deepEqual(ok.attestation, PINNED);
  const dev = loadBootConfig({ NODE_ENV: "development" });
  assert.equal(dev.attestation, undefined);
  assert.equal(dev.adminToken, "dev-token");
});

test("attestation endpoint bytes match injected metadata and stay stable", async () => {
  const app = await appWith(PINNED);
  const first = await app.request("/.well-known/openquick-release.json");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const firstBody = await first.json();
  assert.deepEqual(firstBody, PINNED);

  const second = await app.request("/.well-known/openquick-release.json?sourceRevision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&OPENQUICK_ADMIN_TOKEN=leaked");
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.deepEqual(secondBody, firstBody);
  assert.equal(JSON.stringify(secondBody), JSON.stringify(PINNED));
});

test("attestation JSON never includes representative secrets", async () => {
  const secretAttestation: OpenQuickRelease = {
    ...PINNED,
    deploymentId: "deploy-public-id",
  };
  const app = await appWith(secretAttestation);
  const previousAdmin = process.env.OPENQUICK_ADMIN_TOKEN;
  const previousRailway = process.env.RAILWAY_TOKEN;
  const previousRandom = process.env.OPENQUICK_TEST_RANDOM_SECRET;
  process.env.OPENQUICK_ADMIN_TOKEN = "super-secret-admin-token-value";
  process.env.RAILWAY_TOKEN = "railway-token-should-never-leak";
  process.env.OPENQUICK_TEST_RANDOM_SECRET = "random-env-secret-value";
  try {
    const response = await app.request("/.well-known/openquick-release.json");
    const raw = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(raw, /super-secret-admin-token-value/);
    assert.doesNotMatch(raw, /railway-token-should-never-leak/);
    assert.doesNotMatch(raw, /random-env-secret-value/);
    assert.doesNotMatch(raw, /OPENQUICK_ADMIN_TOKEN/);
    assert.doesNotMatch(raw, /RAILWAY_TOKEN/);
    const body = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["builtAt", "deploymentId", "schema", "service", "sourceRevision"]);
  } finally {
    if (previousAdmin === undefined) delete process.env.OPENQUICK_ADMIN_TOKEN;
    else process.env.OPENQUICK_ADMIN_TOKEN = previousAdmin;
    if (previousRailway === undefined) delete process.env.RAILWAY_TOKEN;
    else process.env.RAILWAY_TOKEN = previousRailway;
    if (previousRandom === undefined) delete process.env.OPENQUICK_TEST_RANDOM_SECRET;
    else process.env.OPENQUICK_TEST_RANDOM_SECRET = previousRandom;
  }
});

test("missing attestation in non-production 404s the well-known route", async () => {
  const app = await appWith();
  const response = await app.request("/.well-known/openquick-release.json");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});
