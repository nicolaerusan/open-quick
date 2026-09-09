import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { stripeMetadata, type CheckoutSnapshot, type StripeGateway, type StripeOffer, type StripePurchase, type VerifiedStripeEvent } from "../src/stripe-payments.js";
import { ProPayments } from "../src/pro-payments.js";
import { SiteStore } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const offer: StripeOffer = { version: 1, accountId: "acct_test_openquick", priceId: "price_test_openquick", mode: "test", amount: 500, currency: "usd", termDays: 30, siteCount: 1, seller: "Weird Systems" };

class FakeStripeGateway implements StripeGateway {
  offer = offer;
  paid = false;
  orderId?: string;
  metadata: Record<string, string> = {};
  async create(order: Parameters<StripeGateway["create"]>[0]) { this.orderId = order.id; this.metadata = stripeMetadata(order); return { id: "cs_test_openquick", url: "https://checkout.stripe.com/c/pay/cs_test_openquick" }; }
  async retrieve(purchase: StripePurchase): Promise<CheckoutSnapshot> {
    return { id: purchase.sessionId!, mode: "payment", live: false, status: this.paid ? "complete" : "open", paymentStatus: this.paid ? "paid" : "unpaid", amount: 500, currency: "usd", orderId: this.orderId ?? null, metadata: this.metadata, priceId: offer.priceId, quantity: 1,
      paymentIntent: { id: "pi_test_openquick", amount: 500, currency: "usd", status: this.paid ? "succeeded" : "requires_payment_method", metadata: this.metadata }, refunded: 0, disputed: false };
  }
  event(_body: string, _signature: string): VerifiedStripeEvent { return { id: "evt_test_openquick", type: "checkout.session.completed", live: false }; }
}

test("Stripe checkout stays bound to the $5 offer and publishes only after verified payment", async () => {
  const root = await mkdtemp(join(tmpdir(), "oq-stripe-test-")); roots.push(root);
  const store = new SiteStore(root); await store.initialize();
  const gateway = new FakeStripeGateway();
  const payments = new ProPayments({ root, recipient: "0x1111111111111111111111111111111111111111", secret: "ab".repeat(32), baseUrl: "https://openquick.test", actors: ["operator"], privateHosting: true, stripe: gateway }, store);
  const files = [{ path: "index.html", content: Buffer.from("<h1>paid privately</h1>").toString("base64") }];
  const created = await payments.create("operator", "stripe-purchase", files, { name: "Stripe project", viewers: [] });
  assert.equal(created.cardOffer.amount, "$5.00");
  const checkout = await payments.stripeCheckout(created.id, "operator");
  assert.equal(checkout.stripeCheckoutUrl, "https://checkout.stripe.com/c/pay/cs_test_openquick");
  assert.equal(payments.read(created.id).status, "pending");
  assert.equal((await payments.reconcileStripe(created.id, "operator")).status, "pending");
  gateway.paid = true;
  const published = await payments.reconcileStripe(created.id, "operator", "evt_test_openquick");
  assert.equal(published.status, "published");
  assert.equal(published.amount, "0.01");
  assert.match(published.transaction, /^stripe:pi_test_openquick$/);
  assert.equal((await store.site(published.site.slug)).slug, published.site.slug);
  assert.equal(payments.read(created.id).stripe?.lastEventId, "evt_test_openquick");
});
