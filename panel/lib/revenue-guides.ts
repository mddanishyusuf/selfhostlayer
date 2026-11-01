// What each payment provider needs for its payments to be credited to visits:
// what's counted from it, its key (or its webhook's signing secret) and where
// to make one, and the lines a site adds to its checkout. Shown on a site's
// Settings in Analytics. Nothing of the server's: the forms use it too.
export type ProviderId = "stripe" | "polar" | "paddle" | "dodo" | "creem" | "lemonsqueezy";

export interface Guide {
  /** What's counted from it. */
  counts: string;
  key: { label: string; hint: string; placeholder: string };
  /** Its test mode, when the key doesn't say which it is. */
  test?: { name: string; hint: string };
  /** Providers that post their payments: where the webhook is added, its events, and whose signing secret it is. */
  webhook?: { where: string; events: string[]; secret: "theirs" | "ours" };
  /** The checkout code that passes the visit. */
  code: string;
  /** Links on the site's pages that get the visit from the script, with nothing to add. */
  links?: string;
}

const BROWSER = `// In the page: the visit, from the Analytics script
const visit = window.shl ? await window.shl.ready : null;
await fetch("/api/checkout", { method: "POST", body: JSON.stringify({ visit }) });`;

export const GUIDES: Record<ProviderId, Guide> = {
  stripe: {
    counts: "Completed checkouts, and paid invoices for renewals.",
    key: { label: "Restricted key", hint: "Developers → API keys → Create restricted key, with Read on Checkout Sessions and Invoices", placeholder: "rk_live_…" },
    code: `${BROWSER}

// On your server (stripe-node): the visit in the Checkout Session's metadata
const session = await stripe.checkout.sessions.create({
  mode: "payment",
  line_items: [{ price: "price_…", quantity: 1 }],
  success_url: "https://example.com/thanks",
  metadata: { shl_visit: visit },
});`,
    links: "Payment Links on your pages (buy.stripe.com) get the visit when clicked, as client_reference_id.",
  },
  polar: {
    counts: "Paid orders, from production or the sandbox.",
    key: { label: "Organization access token", hint: "Settings → Developers → New token, with orders:read", placeholder: "polar_oat_…" },
    test: { name: "Sandbox", hint: "Sandbox is sandbox.polar.sh" },
    code: `${BROWSER}

// On your server (@polar-sh/sdk): the visit in the checkout's metadata
const checkout = await polar.checkouts.create({
  products: ["<product id>"],
  successUrl: "https://example.com/thanks",
  metadata: { shl_visit: visit },
});`,
  },
  paddle: {
    counts: "Completed transactions: checkouts, and subscription renewals.",
    key: { label: "API key", hint: "Developer tools → Authentication → New API key, with Read on transactions", placeholder: "pdl_live_apikey_…" },
    test: { name: "Sandbox", hint: "A sandbox key (pdl_sdbx_…) says so itself" },
    code: `// In the page (Paddle.js): the visit as the checkout's custom data
Paddle.Checkout.open({
  items: [{ priceId: "pri_…", quantity: 1 }],
  customData: { shl_visit: window.shl ? window.shl.visit : null },
});

// Or on a transaction made through the API
custom_data: { shl_visit: visit }`,
  },
  dodo: {
    counts: "Succeeded payments, in your account's currency.",
    key: { label: "API key", hint: "Developer → API Keys → Add API key", placeholder: "Your Dodo Payments API key" },
    test: { name: "Test", hint: "Test mode is Dodo's test environment" },
    code: `${BROWSER}

// On your server (dodopayments): the visit in the payment's metadata
const payment = await dodo.payments.create({
  // …product_cart, customer and billing, as you have them
  payment_link: true,
  metadata: { shl_visit: visit },
});`,
    links: "Payment links on your pages (checkout.dodopayments.com) get the visit when clicked.",
  },
  creem: {
    counts: "Completed checkouts and subscription payments, as Creem's webhook sends them.",
    key: { label: "Signing secret", hint: "Shown in Creem once the webhook is added", placeholder: "whsec_…" },
    test: { name: "Test", hint: "Test counts Creem's test-mode payments only" },
    webhook: { where: "In Creem: Developers → Webhooks → Add webhook, with this URL and these events", events: ["checkout.completed", "subscription.paid"], secret: "theirs" },
    code: `${BROWSER}

// On your server: the visit in the checkout's metadata (Creem's API)
const res = await fetch("https://api.creem.io/v1/checkouts", {
  method: "POST",
  headers: { "x-api-key": process.env.CREEM_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({
    product_id: "prod_…",
    success_url: "https://example.com/thanks",
    metadata: { shl_visit: visit },
  }),
});
const { checkout_url } = await res.json();`,
  },
  lemonsqueezy: {
    counts: "Orders, and subscription renewals, as Lemon Squeezy's webhook sends them.",
    key: { label: "Signing secret", hint: "The same secret the webhook has in Lemon Squeezy", placeholder: "The webhook's signing secret" },
    test: { name: "Test", hint: "Test counts test-mode payments only, from a test-mode webhook" },
    webhook: { where: "In Lemon Squeezy: Settings → Webhooks → +, with this URL, this signing secret and these events", events: ["order_created", "subscription_payment_success"], secret: "ours" },
    code: `${BROWSER}

// On your server (@lemonsqueezy/lemonsqueezy.js): the visit as custom data
const { data } = await createCheckout(storeId, variantId, {
  checkoutData: { custom: { shl_visit: visit } },
});`,
    links: "Buy links on your pages (…lemonsqueezy.com/buy/…) get the visit when clicked.",
  },
};
