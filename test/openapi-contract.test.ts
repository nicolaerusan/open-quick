import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ActivationStore } from "../src/activation.js";
import { createApp } from "../src/app.js";
import { MAX_DEPLOY_BYTES, SiteStore } from "../src/store.js";

type JsonObject = Record<string, unknown>;

type OpenApiDocument = JsonObject & {
  openapi: string;
  components: {
    schemas: Record<string, JsonObject>;
  };
  paths: Record<string, JsonObject>;
};

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openquick-contract-"));
  roots.push(root);
  const store = new SiteStore(root);
  const activations = new ActivationStore(root);
  await store.initialize();
  await activations.initialize();
  return createApp({ store, activations, adminToken: "test-token", baseUrl: "https://openquick.test" });
}


function pathResponseSchemaRef(document: OpenApiDocument, path: string, method: string, status: string): string {
  const item = document.paths[path] as Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> }> | undefined;
  const ref = item?.[method]?.responses?.[status]?.content?.["application/json"]?.schema?.$ref;
  assert.equal(typeof ref, "string", `${method.toUpperCase()} ${path} ${status} must declare an application/json schema`);
  return ref;
}

function responseSchemaRef(document: OpenApiDocument, status: string): string {
  const deploy = document.paths["/api/v1/sites/{slug}/deploy"] as {
    post?: { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> };
  };
  const ref = deploy.post?.responses?.[status]?.content?.["application/json"]?.schema?.$ref;
  assert.equal(typeof ref, "string", `response ${status} must declare an application/json schema`);
  return ref;
}

test("deploy response payloads satisfy the published OpenAPI contract", async () => {
  const app = await fixture();
  const document = await (await app.request("/openapi.json")).json() as OpenApiDocument;

  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.components.schemas).sort(), [
    "DeployReceipt",
    "ErrorEnvelope",
    "HealthResponse",
    "SiteDetailResponse",
    "SiteListResponse",
    "SiteNotFoundError",
    "SiteRecord",
  ]);
  assert.ok(document.paths["/api/v1/agent-connections"]);
  assert.equal(responseSchemaRef(document, "201"), "#/components/schemas/DeployReceipt");
  const receiptSchema = document.components.schemas.DeployReceipt as { required?: string[]; properties?: Record<string, unknown> };
  assert.deepEqual(receiptSchema.required, ["site", "url", "releaseUrl"]);
  assert.ok(receiptSchema.properties?.releaseUrl);
  for (const status of ["401", "413", "422"]) {
    assert.equal(responseSchemaRef(document, status), "#/components/schemas/ErrorEnvelope");
  }

  const schemaId = "https://openquick.test/openapi-contract.json";
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema({ ...document, $id: schemaId });
  const validateReceipt = ajv.compile({ $ref: `${schemaId}#/components/schemas/DeployReceipt` });
  const validateError = ajv.compile({ $ref: `${schemaId}#/components/schemas/ErrorEnvelope` });

  const unauthorized = await app.request("/api/v1/sites/demo/deploy", { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401);
  const unauthorizedBody = await unauthorized.json();
  assert.deepEqual(unauthorizedBody, { error: "A valid deploy token is required", code: "unauthorized" });
  assert.ok(validateError(unauthorizedBody), JSON.stringify(validateError.errors));

  const oversized = await app.request("/api/v1/sites/demo/deploy", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "content-length": String(Math.ceil(MAX_DEPLOY_BYTES * 1.45) + 1),
    },
    body: "{}",
  });
  assert.equal(oversized.status, 413);
  const oversizedBody = await oversized.json();
  assert.deepEqual(oversizedBody, { error: "Deploy request is too large", code: "payload_too_large" });
  assert.ok(validateError(oversizedBody), JSON.stringify(validateError.errors));

  const invalid = await app.request("/api/v1/sites/demo/deploy", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ files: [{ path: "../private.txt", content: Buffer.from("secret content").toString("base64") }] }),
  });
  assert.equal(invalid.status, 422);
  const invalidBody = await invalid.json();
  assert.deepEqual(invalidBody, { error: "Deployment validation failed", code: "invalid_deployment" });
  assert.ok(validateError(invalidBody), JSON.stringify(validateError.errors));
  assert.doesNotMatch(JSON.stringify(invalidBody), /private\.txt|secret content|test-token/);

  const deployed = await app.request("/api/v1/sites/demo/deploy", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ files: [{ path: "index.html", content: Buffer.from("<h1>Hello</h1>").toString("base64") }] }),
  });
  assert.equal(deployed.status, 201);
  const receipt = await deployed.json() as { url: string; releaseUrl: string; site: JsonObject & { releaseId: string; deployedBy: string } };
  assert.ok(validateReceipt(receipt), JSON.stringify(validateReceipt.errors));
  assert.equal(receipt.url, "https://openquick.test/sites/demo/");
  assert.equal(receipt.releaseUrl, `https://openquick.test/sites/demo/releases/${receipt.site.releaseId}/`);
  assert.deepEqual(Object.keys(receipt).sort(), ["releaseUrl", "site", "url"]);
  assert.deepEqual(Object.keys(receipt.site).sort(), [
    "createdAt", "deployedBy", "fileCount", "releaseId", "slug", "totalBytes", "updatedAt",
  ]);
  assert.equal(receipt.site.deployedBy, "operator");
});

test("public-read response payloads satisfy the published OpenAPI contract", async () => {
  const app = await fixture();
  const document = await (await app.request("/openapi.json")).json() as OpenApiDocument;

  assert.equal(pathResponseSchemaRef(document, "/healthz", "get", "200"), "#/components/schemas/HealthResponse");
  assert.equal(pathResponseSchemaRef(document, "/api/v1/sites", "get", "200"), "#/components/schemas/SiteListResponse");
  assert.equal(pathResponseSchemaRef(document, "/api/v1/sites/{slug}", "get", "200"), "#/components/schemas/SiteDetailResponse");
  assert.equal(pathResponseSchemaRef(document, "/api/v1/sites/{slug}", "get", "404"), "#/components/schemas/SiteNotFoundError");

  const schemaId = "https://openquick.test/openapi-public-read.json";
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema({ ...document, $id: schemaId });
  const validateHealth = ajv.compile({ $ref: `${schemaId}#/components/schemas/HealthResponse` });
  const validateList = ajv.compile({ $ref: `${schemaId}#/components/schemas/SiteListResponse` });
  const validateDetail = ajv.compile({ $ref: `${schemaId}#/components/schemas/SiteDetailResponse` });
  const validateNotFound = ajv.compile({ $ref: `${schemaId}#/components/schemas/SiteNotFoundError` });

  const health = await (await app.request("/healthz")).json();
  assert.deepEqual(health, { ok: true });
  assert.ok(validateHealth(health), JSON.stringify(validateHealth.errors));

  const emptyList = await (await app.request("/api/v1/sites")).json();
  assert.deepEqual(emptyList, { sites: [] });
  assert.ok(validateList(emptyList), JSON.stringify(validateList.errors));

  const missing = await app.request("/api/v1/sites/missing-site");
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.deepEqual(missingBody, { error: "Site not found" });
  assert.ok(validateNotFound(missingBody), JSON.stringify(validateNotFound.errors));
  assert.equal("code" in (missingBody as object), false);

  const deployed = await app.request("/api/v1/sites/public-read/deploy", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ files: [{ path: "index.html", content: Buffer.from("<h1>Public</h1>").toString("base64") }] }),
  });
  assert.equal(deployed.status, 201);

  const listed = await (await app.request("/api/v1/sites")).json() as { sites: Array<Record<string, unknown>> };
  assert.ok(validateList(listed), JSON.stringify(validateList.errors));
  assert.equal(listed.sites.length, 1);
  assert.equal(listed.sites[0]?.slug, "public-read");

  // Older public-read rows may omit deployedBy; shared SiteRecord must still validate.
  const legacyList = { sites: [{ ...listed.sites[0] }] };
  delete legacyList.sites[0].deployedBy;
  assert.ok(validateList(legacyList), JSON.stringify(validateList.errors));

  const detail = await app.request("/api/v1/sites/public-read");
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.ok(validateDetail(detailBody), JSON.stringify(validateDetail.errors));
  assert.equal(Object.keys(detailBody as object).sort().join(","), "site");
  assert.notEqual(Object.keys(listed).sort().join(","), Object.keys(detailBody as object).sort().join(","));
});

