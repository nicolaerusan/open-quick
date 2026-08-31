import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
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
  await store.initialize();
  return createApp({ store, adminToken: "test-token", baseUrl: "https://openquick.test" });
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
  assert.deepEqual(Object.keys(document.components.schemas).sort(), ["DeployReceipt", "ErrorEnvelope", "SiteRecord"]);
  assert.equal(responseSchemaRef(document, "201"), "#/components/schemas/DeployReceipt");
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
  const receipt = await deployed.json();
  assert.ok(validateReceipt(receipt), JSON.stringify(validateReceipt.errors));
  assert.deepEqual(Object.keys((receipt as { site: JsonObject }).site).sort(), [
    "createdAt", "fileCount", "releaseId", "slug", "totalBytes", "updatedAt",
  ]);
});
