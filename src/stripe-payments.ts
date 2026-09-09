import Stripe from "stripe";
import type { ProOrder } from "./pro-payments.js";

export type StripeOffer = {
  version: 1; accountId: string; priceId: string; mode: "test" | "live";
  amount: 500; currency: "usd"; termDays: 30; siteCount: 1; seller: string;
};
export type StripePurchase = {
  offer: StripeOffer; attempt: number; requestedAt?: string; sessionId?: string; checkoutUrl?: string;
  sessionStatus?: string; paymentIntentId?: string; chargeId?: string; paidAt?: string;
  customerEmail?: string; customerName?: string; customerId?: string;
  fee?: number; net?: number; refunded: number; disputed: boolean;
  receiptUrl?: string; reconciledAt?: string; lastEventId?: string;
};
export type CheckoutSnapshot = {
  id: string; mode: string; live: boolean; status: string; paymentStatus: string;
  amount: number | null; currency: string | null; orderId: string | null;
  metadata: Record<string, string>; priceId: string | null; quantity: number | null;
  paymentIntent?: { id: string; amount: number; currency: string; status: string; metadata: Record<string, string> };
  chargeId?: string; customerEmail?: string; customerName?: string; customerId?: string;
  fee?: number; net?: number; refunded: number; disputed: boolean; receiptUrl?: string;
};
export type VerifiedStripeEvent = {
  id: string; type: string; live: boolean; account?: string;
  orderId?: string; sessionId?: string; paymentIntentId?: string; chargeId?: string;
};
export interface StripeGateway {
  offer: StripeOffer;
  create(order: ProOrder): Promise<{ id: string; url: string }>;
  retrieve(purchase: StripePurchase): Promise<CheckoutSnapshot>;
  event(body: string, signature: string): VerifiedStripeEvent;
}
export function validateStripeOffer(value: unknown): StripeOffer {
  const o = value as StripeOffer | undefined;
  if (!o || o.version !== 1 || !/^acct_[A-Za-z0-9]+$/.test(o.accountId) || !/^price_[A-Za-z0-9]+$/.test(o.priceId) ||
    !["test", "live"].includes(o.mode) || o.amount !== 500 || o.currency !== "usd" || o.termDays !== 30 || o.siteCount !== 1 ||
    typeof o.seller !== "string" || !o.seller.trim() || o.seller.length > 100) throw Error("Invalid Stripe hosting offer");
  return { ...o };
}
export function stripeMetadata(order: ProOrder) {
  return { openquick_order: order.id, commons_space: "open-quick", commons_service: "openquick-private-hosting",
    commons_offering: "private-site-30-days-v1", openquick_project: order.slug,
    openquick_actor: order.actor, hosting_days: "30", site_count: "1" };
}
export function matchesStripeCheckout(order: ProOrder, s: CheckoutSnapshot) {
  const p = order.stripe;
  if (!p || s.id !== p.sessionId || s.mode !== "payment" || s.live !== (p.offer.mode === "live") ||
    s.orderId !== order.id || s.amount !== p.offer.amount || s.currency !== p.offer.currency ||
    s.priceId !== p.offer.priceId || s.quantity !== 1 ||
    Object.entries(stripeMetadata(order)).some(([k,v]) => s.metadata[k] !== v)) return false;
  if (s.paymentIntent && (s.paymentIntent.amount !== p.offer.amount || s.paymentIntent.currency !== p.offer.currency ||
    Object.entries(stripeMetadata(order)).some(([k,v]) => s.paymentIntent!.metadata[k] !== v))) return false;
  if (p.paymentIntentId && s.paymentIntent?.id !== p.paymentIntentId) return false;
  return true;
}

/** Only this trusted server receives Stripe credentials; uploaded projects never do. */
export class HostedStripeGateway implements StripeGateway {
  readonly offer: StripeOffer;
  private client: Stripe;
  constructor(offer: StripeOffer, secretKey: string, private readonly webhookSecret: string, private readonly checkoutOrigin: string) {
    this.offer = validateStripeOffer(offer);
    if (!new RegExp(`^(?:sk|rk)_${offer.mode}_`).test(secretKey) || !webhookSecret.startsWith("whsec_")) throw Error("Stripe credentials must match the configured environment");
    const url = new URL(checkoutOrigin);
    if (url.origin !== checkoutOrigin || (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))) throw Error("Stripe needs a trusted HTTPS checkout origin");
    this.client = new Stripe(secretKey, { timeout: 20_000, maxNetworkRetries: 1 });
  }
  async ready() {
    const [account, price] = await Promise.all([this.client.accounts.retrieve(this.offer.accountId), this.client.prices.retrieve(this.offer.priceId)]);
    if (account.id !== this.offer.accountId || !account.charges_enabled || !price.active || price.livemode !== (this.offer.mode === "live") ||
      price.currency !== "usd" || price.unit_amount !== 500 || price.type !== "one_time") throw Error("Stripe account or price does not match the hosting offer");
  }
  private account(purchase: StripePurchase) {
    if (purchase.offer.accountId !== this.offer.accountId || purchase.offer.mode !== this.offer.mode) throw Error("This historical Stripe account/environment needs its original provider configuration");
  }
  async create(order: ProOrder) {
    const purchase = order.stripe!; this.account(purchase);
    const metadata = stripeMetadata(order);
    const session = await this.client.checkout.sessions.create({
      mode: "payment", payment_method_types: ["card", "link"],
      line_items: [{ price: purchase.offer.priceId, quantity: 1 }],
      client_reference_id: order.id, metadata, payment_intent_data: { metadata },
      branding_settings: { display_name: "OpenQuick", background_color: "#f5f3ec", button_color: "#1f231c" },
      success_url: `${this.checkoutOrigin}/pro/hosting?stripe_order=${order.id}`,
      cancel_url: `${this.checkoutOrigin}/pro/hosting?stripe_order=${order.id}&cancelled=1`,
      expires_at: Math.floor(Date.parse(order.expiresAt) / 1000),
      custom_text: { submit: { message: "$5 once for one private static site, hosted for 30 days. Updates included. No automatic renewal; the site becomes unavailable when the term ends." } },
    }, { idempotencyKey: `openquick:${order.id}:stripe:${purchase.attempt}` });
    if (session.livemode !== (purchase.offer.mode === "live") || !session.url || !session.url.startsWith("https://checkout.stripe.com/")) throw Error("Unexpected Stripe checkout destination");
    return { id: session.id, url: session.url };
  }
  async retrieve(purchase: StripePurchase): Promise<CheckoutSnapshot> {
    this.account(purchase);
    if (!purchase.sessionId) throw Error("No Checkout Session recorded");
    const s = await this.client.checkout.sessions.retrieve(purchase.sessionId, { expand: ["line_items.data.price", "payment_intent.latest_charge.balance_transaction"] });
    const pi = s.payment_intent && typeof s.payment_intent !== "string" ? s.payment_intent : undefined;
    const charge = pi?.latest_charge && typeof pi.latest_charge !== "string" ? pi.latest_charge : undefined;
    const balance = charge?.balance_transaction && typeof charge.balance_transaction !== "string" ? charge.balance_transaction : undefined;
    // A charge's disputed flag can remain true after resolution. Read current dispute status.
    let disputed = charge?.disputed ?? false;
    if (disputed && pi) {
      const disputes = await this.client.disputes.list({ payment_intent: pi.id, limit: 10 });
      disputed = disputes.data.some(d => !["won", "warning_closed"].includes(d.status));
    }
    return {
      id: s.id, mode: s.mode, live: s.livemode, status: s.status ?? "unknown", paymentStatus: s.payment_status,
      amount: s.amount_total, currency: s.currency, orderId: s.client_reference_id, metadata: s.metadata ?? {},
      priceId: s.line_items?.data.length === 1 ? s.line_items.data[0]!.price?.id ?? null : null,
      quantity: s.line_items?.data.length === 1 ? s.line_items.data[0]!.quantity : null,
      ...(pi ? { paymentIntent: { id: pi.id, amount: pi.amount, currency: pi.currency, status: pi.status, metadata: pi.metadata } } : {}),
      ...(charge ? { chargeId: charge.id } : {}),
      ...(s.customer_details?.email ? { customerEmail: s.customer_details.email } : {}),
      ...(s.customer_details?.name ? { customerName: s.customer_details.name } : {}),
      ...(s.customer ? { customerId: typeof s.customer === "string" ? s.customer : s.customer.id } : {}),
      ...(balance && balance.currency === "usd" ? { fee: balance.fee, net: balance.net } : {}),
      refunded: charge?.amount_refunded ?? 0, disputed,
      ...(charge?.receipt_url ? { receiptUrl: charge.receipt_url } : {}),
    };
  }
  event(body: string, signature: string): VerifiedStripeEvent {
    const e = this.client.webhooks.constructEvent(body, signature, this.webhookSecret);
    const object = e.data.object as unknown as { id: string; metadata?: Record<string,string>; payment_intent?: string | { id: string }; charge?: string | { id: string } };
    return { id: e.id, type: e.type, live: e.livemode, ...(e.account ? { account: e.account } : {}),
      ...(object.metadata?.openquick_order ? { orderId: object.metadata.openquick_order } : {}),
      ...(e.type.startsWith("checkout.session.") ? { sessionId: object.id } : {}),
      ...(object.payment_intent ? { paymentIntentId: typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent.id } : {}),
      ...(e.type === "charge.refunded" ? { chargeId: object.id } : object.charge ? { chargeId: typeof object.charge === "string" ? object.charge : object.charge.id } : {}),
    };
  }
}
