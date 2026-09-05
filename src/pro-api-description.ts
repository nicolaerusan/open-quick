const json = (schema: object) => ({ content: { "application/json": { schema } } });
const string = { type: "string" };
const order = {
  type: "object", required: ["id", "status", "amount", "currency", "network", "testMode", "recipient", "contentHash", "paymentUrl", "checkoutUrl", "expiresAt"],
  properties: {
    id: { type: "string", pattern: "^[a-f0-9]{48}$" }, status: { enum: ["pending", "paid", "published", "needs_review"] },
    product: string, amount: { const: "0.01" }, currency: { const: "pathUSD" }, network: { const: "tempo-testnet" }, testMode: { const: true },
    recipient: string, contentHash: string, paymentUrl: string, checkoutUrl: string, expiresAt: string,
    transaction: string, url: string, releaseUrl: string, site: { $ref: "#/components/schemas/SiteRecord" },
  },
};
const error = { description: "Rejected or temporarily unavailable. A needs-review outcome must not be paid again.", ...json({ type: "object", required: ["error"], properties: { error: string } }) };
const errors = Object.fromEntries([401, 403, 404, 409, 410, 413, 422, 429, 503].map((code) => [String(code), error]));
const id = [{ in: "path", name: "id", required: true, schema: { type: "string", pattern: "^[a-f0-9]{48}$" } }];
export const proPaths = {
  "/api/v1/pro-deploys": { post: {
    operationId: "createProDeploy", summary: "Private pilot: prepare one paid static release", security: [{ bearerAuth: [] }],
    description: "Requires a pilot-allowed, unscoped deploy identity. The owner must also authenticate checkout, status and payment requests. For MPP, supply X-OpenQuick-Authorization: Bearer <credential> separately from Authorization: Payment <proof>. No charge occurs on creation. The exact content and price are fixed. Max 1 MB decoded, 50 files, 1.5 MB request, 20 new intents per actor/hour. Reuse the idempotency key after a lost response; different content returns 409.",
    parameters: [{ in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 128 } }],
    requestBody: { required: true, ...json({ type: "object", required: ["files"], properties: { files: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", required: ["path", "content"], properties: { path: string, content: { type: "string", description: "Base64 file bytes" } } } } } }) },
    responses: { "201": { description: "Existing or newly prepared intent", ...json(order) }, ...errors },
  } },
  "/api/v1/pro-payments/{id}": { get: {
    operationId: "getProPayment", summary: "Owner: read a payment intent without contacting a provider", security: [{ bearerAuth: [] }], parameters: id,
    responses: { "200": { description: "Intent or published release", ...json(order) }, ...errors },
  } },
  "/api/v1/pro-payments/{id}/pay": { get: {
    operationId: "payProDeploy", summary: "Owner: MPP Tempo charge, then publish the fixed release", security: [{ bearerAuth: [] }], parameters: [...id, { in: "header", name: "X-OpenQuick-Authorization", required: true, schema: string, description: "Bearer application credential; separate from the MPP Payment authorization" }],
    description: "Requires the allowlisted owner's application credential on every request. Returns an MPP WWW-Authenticate challenge when unpaid. Retry with the Payment credential and the same X-OpenQuick-Authorization header. Only a confirmed testnet transfer publishes content. Published requests return the same release without another payment. An interrupted uncertain settlement fails closed for operator reconciliation. Card and live payments are disabled.",
    responses: { "200": { description: "Published release and Payment-Receipt", ...json(order) }, "402": { description: "MPP charge challenge in WWW-Authenticate" }, ...errors },
  } },
};
