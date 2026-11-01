// Revenue from Stripe, Polar, Paddle, Dodo Payments, Creem and Lemon Squeezy,
// credited to the visits that brought it, with no cookies:
//   1. the script names the visit (window.shl.visit, or await window.shl.ready);
//   2. the site passes it into its checkout as shl_visit: metadata (Stripe,
//      Polar, Dodo, Creem), custom_data (Paddle) or custom data (Lemon
//      Squeezy); links to Stripe Payment Links, Dodo Payments and Lemon
//      Squeezy get it from the script;
//   3. Analytics pulls the payments of Stripe, Polar, Paddle and Dodo with a
//      key per provider, every 10 minutes and on Sync now, from a day before
//      the last sync (90 days the first time). Creem and Lemon Squeezy show
//      no checkout's data in their APIs: their webhooks post each payment to
//      /webhooks/<provider>/<site>, checked against the signing secret.
// Kept: the amount without tax, its currency and time, and the provider's
// customer id; no email or name. A payment with no visit of its own (a
// renewal, a second purchase) goes to its customer's first visit. Keys are
// kept encrypted under a key made from the admin token, so the database alone
// doesn't give them away.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import { VISIT_ID } from "./ingest.ts";
import { DAY, type Filters, HOUR, type Range, visitFilters, visitWhere, windowOf } from "./stats.ts";

export const PROVIDERS = ["stripe", "polar", "paddle", "dodo", "creem", "lemonsqueezy"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type Mode = "live" | "test";
/** The providers that post their payments here, rather than being pulled. */
export const WEBHOOKS: readonly Provider[] = ["creem", "lemonsqueezy"];
type Pulls = Exclude<Provider, "creem" | "lemonsqueezy">;

export const NAMES: Record<Provider, string> = { stripe: "Stripe", polar: "Polar", paddle: "Paddle", dodo: "Dodo Payments", creem: "Creem", lemonsqueezy: "Lemon Squeezy" };
const BASES: Record<Pulls, Record<Mode, string>> = {
  stripe: { live: "https://api.stripe.com/v1", test: "https://api.stripe.com/v1" },
  polar: { live: "https://api.polar.sh/v1", test: "https://sandbox-api.polar.sh/v1" },
  paddle: { live: "https://api.paddle.com", test: "https://sandbox-api.paddle.com" },
  dodo: { live: "https://live.dodopayments.com", test: "https://test.dodopayments.com" },
};
/** The header each webhook's HMAC-SHA256 (hex, of the raw body) comes in. */
export const SIGNATURE_HEADERS: Record<string, string> = { creem: "creem-signature", lemonsqueezy: "x-signature" };

/** Each sync starts this long before the last one: a checkout is listed by when it opened, and stays open up to a day. */
export const OVERLAP = DAY + 20 * 60_000;
export const FIRST_DAYS = 90;
export const SYNC_EVERY = 10 * 60_000;
const MAX_PAGES = 100;

/** A payment as a provider lists it. */
export interface Pulled {
  id: string;
  at: number;
  /** In the currency's smallest unit, without tax; 0 for a checkout that took no money (a free trial), which only ties the customer to its visit. */
  amount: number;
  currency: string;
  customer: string | null;
  /** The visit the checkout named (shl_visit). */
  visit: string | null;
  renewal: boolean;
}

export interface Source {
  provider: Provider;
  mode: Mode;
  /** The key's last 4 characters. */
  keyHint: string;
  syncedAt: number | null;
  error: string | null;
  errorAt: number | null;
  syncing: boolean;
  payments: number;
  createdAt: number;
}

interface SourceRow {
  site_id: number;
  provider: Provider;
  api_key: string;
  key_hint: string;
  mode: Mode;
  synced_at: number | null;
  sync_error: string | null;
  error_at: number | null;
  created_at: number;
}

type Json = Record<string, any>;
type Get = (path: string) => Promise<Json>;

/** The shl_visit a checkout carried, if it's a visit's id. */
function visitIn(metadata: unknown): string | null {
  const v = (metadata as Json | null)?.shl_visit;
  return typeof v === "string" && VISIT_ID.test(v) ? v : null;
}

const idOf = (v: unknown): string | null => (typeof v === "string" ? v : typeof (v as Json | null)?.id === "string" ? (v as Json).id : null);
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function* stripeList(get: Get, path: string, query: Record<string, string>): AsyncGenerator<Json[]> {
  let after = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await get(`${path}?${qs({ ...query, limit: "100", ...(after ? { starting_after: after } : {}) })}`);
    const data = (r.data ?? []) as Json[];
    yield data;
    if (!r.has_more || data.length === 0) return;
    after = String(data.at(-1)!.id);
  }
}

/** Completed checkouts (paid, or a free trial's), and paid invoices after a subscription's first. */
async function* stripe(get: Get, since: number): AsyncGenerator<Pulled[]> {
  const gte = String(Math.floor(since / 1000));
  for await (const page of stripeList(get, "/checkout/sessions", { status: "complete", "created[gte]": gte })) {
    const out: Pulled[] = [];
    for (const s of page) {
      const paid = s.payment_status === "paid" && Number(s.amount_total) > 0;
      if (!paid && !(s.mode === "subscription" && s.payment_status === "no_payment_required")) continue;
      let amount = paid ? Number(s.amount_total) - (Number(s.total_details?.amount_tax) || 0) : 0;
      let currency = String(s.currency ?? "usd");
      // Adaptive pricing: the customer paid in their currency; counted in the price's own.
      const cc = s.currency_conversion;
      if (cc?.source_currency && Number(cc.fx_rate) > 0) {
        amount = Math.round(amount / Number(cc.fx_rate));
        currency = String(cc.source_currency);
      }
      const ref = typeof s.client_reference_id === "string" && VISIT_ID.test(s.client_reference_id) ? s.client_reference_id : null;
      out.push({ id: String(s.id), at: Number(s.created) * 1000, amount, currency, customer: idOf(s.customer), visit: visitIn(s.metadata) ?? ref, renewal: false });
    }
    yield out;
  }
  for await (const page of stripeList(get, "/invoices", { status: "paid", "created[gte]": gte })) {
    const out: Pulled[] = [];
    for (const inv of page) {
      // A subscription's first invoice is its checkout's; one-off invoices aren't checkouts.
      const sub = inv.subscription ?? inv.parent?.subscription_details?.subscription;
      if (!sub || inv.billing_reason === "subscription_create") continue;
      const tax = Number(inv.tax) || (Array.isArray(inv.total_taxes) ? inv.total_taxes.reduce((n: number, t: Json) => n + (Number(t.amount) || 0), 0) : 0);
      const amount = (Number(inv.amount_paid) || 0) - tax;
      if (amount <= 0) continue;
      const meta = inv.subscription_details?.metadata ?? inv.parent?.subscription_details?.metadata ?? inv.metadata;
      out.push({ id: String(inv.id), at: Number(inv.status_transitions?.paid_at ?? inv.created) * 1000, amount, currency: String(inv.currency ?? "usd"), customer: idOf(inv.customer), visit: visitIn(meta), renewal: true });
    }
    yield out;
  }
}

/** Paid orders, newest first. */
async function* polar(get: Get, since: number): AsyncGenerator<Pulled[]> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await get(`/orders/?${qs({ sorting: "-created_at", limit: "100", page: String(page), created_after: new Date(since).toISOString() })}`);
    const items = (r.items ?? []) as Json[];
    const out: Pulled[] = [];
    for (const o of items) {
      if (o.paid !== true && !["paid", "refunded", "partially_refunded"].includes(o.status)) continue;
      const at = Date.parse(o.created_at);
      if (!(at >= since)) continue;
      const amount = Number(o.net_amount ?? Number(o.total_amount) - (Number(o.tax_amount) || 0)) || 0;
      out.push({ id: String(o.id), at, amount: Math.max(0, amount), currency: String(o.currency ?? "usd"), customer: idOf(o.customer_id ?? o.customer), visit: visitIn(o.metadata), renewal: !["purchase", "subscription_create"].includes(o.billing_reason) });
    }
    yield out;
    const oldest = Date.parse(items.at(-1)?.created_at ?? "");
    if (items.length === 0 || page >= Number(r.pagination?.max_page ?? page) || oldest < since) return;
  }
}

/**
 * Succeeded payments. The list leaves out tax and what the account is
 * credited (in its own currency, with adaptive pricing), so each new payment
 * is read once on its own.
 */
async function* dodo(get: Get, since: number, known: (id: string) => boolean): AsyncGenerator<Pulled[]> {
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await get(`/payments?${qs({ status: "succeeded", created_at_gte: new Date(since).toISOString(), page_size: "100", page_number: String(page) })}`);
    const items = (r.items ?? []) as Json[];
    const out: Pulled[] = [];
    for (const listed of items) {
      const id = String(listed.payment_id);
      if (known(id)) continue;
      const p = listed.settlement_amount === undefined ? await get(`/payments/${encodeURIComponent(id)}`) : listed;
      const settled = p.settlement_amount !== undefined && p.settlement_amount !== null && typeof p.settlement_currency === "string";
      const amount = settled ? Number(p.settlement_amount) - (Number(p.settlement_tax) || 0) : Number(p.total_amount) - (Number(p.tax) || 0);
      out.push({
        id,
        at: Date.parse(p.created_at),
        amount: Math.max(0, amount || 0),
        currency: String(settled ? p.settlement_currency : (p.currency ?? "usd")),
        customer: idOf(p.customer?.customer_id ?? null),
        visit: visitIn(p.metadata),
        renewal: p.charge_type === "renewal" || p.charge_type === "plan_change",
      });
    }
    yield out;
    if (items.length < 100) return;
  }
}

/**
 * Completed transactions: a checkout's, or a subscription's later payment
 * (its origin says so). Pages of 30, the most Paddle gives.
 */
async function* paddle(get: Get, since: number): AsyncGenerator<Pulled[]> {
  let after = "";
  for (let page = 0; page < MAX_PAGES * 4; page++) {
    const r = await get(`/transactions?${qs({ status: "completed", "billed_at[GTE]": new Date(since).toISOString(), order_by: "billed_at[ASC]", per_page: "30", ...(after ? { after } : {}) })}`);
    const items = (r.data ?? []) as Json[];
    const out: Pulled[] = [];
    for (const t of items) {
      const totals = (t.details?.totals ?? {}) as Json;
      out.push({
        id: String(t.id),
        at: Date.parse(t.billed_at ?? t.created_at),
        amount: Math.max(0, (Number(totals.total) || 0) - (Number(totals.tax) || 0)),
        currency: String(t.currency_code ?? totals.currency_code ?? "usd"),
        customer: idOf(t.customer_id),
        visit: visitIn(t.custom_data),
        renewal: typeof t.origin === "string" && t.origin.startsWith("subscription_"),
      });
    }
    yield out;
    const next = r.meta?.pagination?.next;
    if (items.length < 30 || r.meta?.pagination?.has_more === false || typeof next !== "string") return;
    after = new URL(next).searchParams.get("after") ?? String(items.at(-1)!.id);
  }
}

const time = (v: unknown) => (typeof v === "number" ? v : Date.parse(String(v)));

/**
 * A Lemon Squeezy webhook: a paid order, or a subscription's later payment
 * (its first is the order's). The checkout's custom data comes in meta.
 */
function lemonsqueezy(body: Json, mode: Mode): Pulled[] {
  const a = (body.data?.attributes ?? {}) as Json;
  if (Boolean(a.test_mode ?? body.meta?.test_mode) !== (mode === "test")) return [];
  const paid = { at: time(a.created_at), amount: Math.max(0, (Number(a.total) || 0) - (Number(a.tax) || 0)), currency: String(a.currency ?? "usd"), customer: a.customer_id == null ? null : String(a.customer_id), visit: visitIn(body.meta?.custom_data) };
  const event = body.meta?.event_name;
  if (event === "order_created" && body.data?.type === "orders" && a.status === "paid") return [{ id: `order:${body.data.id}`, ...paid, renewal: false }];
  if (event === "subscription_payment_success" && body.data?.type === "subscription-invoices" && a.status === "paid" && a.billing_reason !== "initial") return [{ id: `invoice:${body.data.id}`, ...paid, renewal: true }];
  return [];
}

/** Creem's modes that aren't live payments. */
const CREEM_TESTS = ["test", "sandbox", "local"];

/**
 * A Creem webhook: a completed checkout's order, or a subscription's payment.
 * A subscription's first payment comes as both: one transaction, kept once.
 */
function creem(body: Json, mode: Mode): Pulled[] {
  const o = (body.object ?? {}) as Json;
  if (CREEM_TESTS.includes(String(o.mode)) !== (mode === "test")) return [];
  if (body.eventType === "checkout.completed") {
    const order = (o.order ?? {}) as Json;
    if (order.status !== "paid") return [];
    return [
      {
        id: String(order.transaction ?? order.id),
        at: time(order.created_at) || time(body.created_at),
        amount: Math.max(0, (Number(order.amount_paid ?? order.amount) || 0) - (Number(order.tax_amount) || 0)),
        currency: String(order.currency ?? "usd"),
        customer: idOf(o.customer) ?? idOf(order.customer),
        visit: visitIn(o.metadata) ?? visitIn(o.subscription?.metadata),
        renewal: false,
      },
    ];
  }
  if (body.eventType === "subscription.paid") {
    const t = (o.last_transaction ?? {}) as Json;
    if (t.status !== "paid" || !t.id) return [];
    return [
      {
        id: String(t.id),
        at: time(t.created_at) || time(body.created_at),
        amount: Math.max(0, (Number(t.amount_paid ?? t.amount) || 0) - (Number(t.tax_amount) || 0)),
        currency: String(t.currency ?? "usd"),
        customer: idOf(o.customer),
        visit: visitIn(o.metadata),
        renewal: true,
      },
    ];
  }
  return [];
}

/** A small request that only works with a key that can read payments. */
const PROBES: Record<Pulls, string> = { stripe: "/checkout/sessions?limit=1", polar: "/orders/?limit=1", paddle: "/transactions?per_page=1", dodo: "/payments?page_size=1" };

/** What a provider said went wrong, from its error body. */
function problemIn(body: Json | null): string | null {
  if (!body) return null;
  const detail = body.detail;
  const text = body.error?.message ?? body.error?.detail ?? (typeof detail === "string" ? detail : Array.isArray(detail) ? detail[0]?.msg : null) ?? body.message ?? (typeof body.error === "string" ? body.error : null);
  return typeof text === "string" ? text.slice(0, 300) : null;
}

export interface RevenueOptions {
  /** ANALYTICS_ADMIN_TOKEN: the keys are encrypted under a key made from it. */
  secret: string;
  /** Writes events still in memory, so a visit named by a payment is in the database. */
  flush?: () => void;
  fetch?: typeof fetch;
  /** Another address for each provider (tests). */
  bases?: Partial<Record<Pulls, string>>;
}

export class Revenue {
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  readonly #flush: () => void;
  readonly #fetch: typeof fetch;
  readonly #bases: Partial<Record<Pulls, string>>;
  #running = new Map<string, Promise<SyncResult>>();

  constructor(db: DatabaseSync, o: RevenueOptions) {
    this.#db = db;
    this.#key = Buffer.from(hkdfSync("sha256", o.secret, "", "analytics: payment provider keys", 32));
    this.#flush = o.flush ?? (() => {});
    this.#fetch = o.fetch ?? fetch;
    this.#bases = o.bases ?? {};
  }

  #seal(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#key, iv);
    const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url")}`;
  }

  #open(sealed: string): string {
    try {
      const raw = Buffer.from(sealed.slice(3), "base64url");
      const d = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    } catch {
      throw new Error("the key can't be read with this install's admin token: enter it again");
    }
  }

  #client(provider: Pulls, mode: Mode, key: string): Get {
    const base = this.#bases[provider] ?? BASES[provider][mode];
    return async (path) => {
      let res: Response;
      try {
        res = await this.#fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        throw new Error(`${NAMES[provider]} didn't answer (${(err as Error).message})`);
      }
      const text = await res.text();
      let body: Json | null = null;
      try {
        body = JSON.parse(text) as Json;
      } catch {
        // not JSON: said as text below
      }
      if (!res.ok) throw new Error(`${NAMES[provider]} answered ${res.status}: ${problemIn(body) ?? (text.slice(0, 200) || res.statusText)}`);
      if (!body) throw new Error(`${NAMES[provider]} answered with something that isn't JSON`);
      return body;
    };
  }

  #row(siteId: number, provider: Provider): SourceRow | undefined {
    return this.#db.prepare("SELECT * FROM revenue_sources WHERE site_id = ? AND provider = ?").get(siteId, provider) as unknown as SourceRow | undefined;
  }

  sources(siteId: number): Source[] {
    const rows = this.#db.prepare("SELECT * FROM revenue_sources WHERE site_id = ? ORDER BY CASE provider WHEN 'stripe' THEN 0 WHEN 'polar' THEN 1 WHEN 'paddle' THEN 2 WHEN 'dodo' THEN 3 WHEN 'creem' THEN 4 ELSE 5 END").all(siteId) as unknown as SourceRow[];
    const counts = new Map((this.#db.prepare("SELECT provider, count(*) n FROM payments WHERE site_id = ? GROUP BY provider").all(siteId) as { provider: string; n: number }[]).map((r) => [r.provider, r.n]));
    return rows.map((r) => ({
      provider: r.provider,
      mode: r.mode,
      keyHint: r.key_hint,
      syncedAt: r.synced_at,
      error: r.sync_error,
      errorAt: r.error_at,
      syncing: this.#running.has(`${siteId}:${r.provider}`),
      payments: counts.get(r.provider) ?? 0,
      createdAt: r.created_at,
    }));
  }

  /**
   * Adds a provider's key, or replaces it, once a small request shows it can
   * read payments; then pulls the last 90 days in the background. Another key
   * or mode starts over: a source's payments are the ones its key can see.
   * A webhook's provider keeps its signing secret instead, and waits for it.
   */
  async setSource(siteId: number, input: Record<string, unknown>): Promise<Source> {
    const provider = input.provider as Provider;
    if (!PROVIDERS.includes(provider)) throw new InputError("provider", `must be one of ${PROVIDERS.join(", ")}`);
    const webhook = WEBHOOKS.includes(provider);
    const key = typeof input.key === "string" ? input.key.trim() : "";
    if (webhook ? key.length < 6 || key.length > 200 || /\s/.test(key) : key.length < 16 || key.length > 500 || /\s/.test(key)) throw new InputError("key", webhook ? `must be the signing secret of ${NAMES[provider]}'s webhook` : `must be a ${NAMES[provider]} API key`);
    let mode: Mode;
    if (provider === "stripe") {
      const m = /^(?:sk|rk)_(live|test)_/.exec(key);
      if (!m) throw new InputError("key", "must be a Stripe secret or restricted key (rk_live_… or sk_live_…)");
      mode = m[1] as Mode;
    } else if (provider === "paddle" && key.startsWith("pdl_")) {
      // Paddle's keys since May 2025; older ones are 50 random characters, and take the mode chosen.
      if (!/^pdl_(live|sdbx)_apikey_[a-z\d]{26}_[a-zA-Z\d]{22}_[a-zA-Z\d]{3}$/.test(key)) throw new InputError("key", "isn't a whole Paddle API key: they start pdl_live_apikey_ (or pdl_sdbx_apikey_) and are 69 characters");
      mode = key.startsWith("pdl_live_") ? "live" : "test";
    } else {
      if (input.mode !== undefined && input.mode !== "live" && input.mode !== "test") throw new InputError("mode", "must be live or test");
      mode = (input.mode as Mode | undefined) ?? "live";
    }
    if (!webhook) {
      try {
        await this.#client(provider as Pulls, mode, key)(PROBES[provider as Pulls]);
      } catch (err) {
        throw new InputError("key", `${(err as Error).message}`);
      }
    }
    const was = this.#row(siteId, provider);
    let same = false;
    if (was && was.mode === mode) {
      try {
        same = this.#open(was.api_key) === key;
      } catch {
        // a key this install can't read: replaced
      }
    }
    this.#db.exec("BEGIN");
    try {
      if (was && !same) this.#forget(siteId, provider);
      this.#db
        .prepare(
          `INSERT INTO revenue_sources (site_id, provider, api_key, key_hint, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (site_id, provider) DO UPDATE SET api_key = excluded.api_key, key_hint = excluded.key_hint, mode = excluded.mode, synced_at = ${same ? "synced_at" : "NULL"}, sync_error = NULL, error_at = NULL`,
        )
        .run(siteId, provider, this.#seal(key), key.slice(-4), mode, Date.now());
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    if (!webhook) this.sync(siteId, provider).catch((err: unknown) => console.error(`syncing ${NAMES[provider]} failed: ${(err as Error).message}`));
    return this.sources(siteId).find((s) => s.provider === provider)!;
  }

  /** A provider's payments and customers, from this site. */
  #forget(siteId: number, provider: Provider): void {
    for (const table of ["payments", "customers"]) this.#db.prepare(`DELETE FROM ${table} WHERE site_id = ? AND provider = ?`).run(siteId, provider);
  }

  removeSource(siteId: number, provider: string): void {
    if (!this.#row(siteId, provider as Provider)) throw new InputError("provider", "isn't connected to this site", 404);
    this.#db.exec("BEGIN");
    try {
      this.#forget(siteId, provider as Provider);
      this.#db.prepare("DELETE FROM revenue_sources WHERE site_id = ? AND provider = ?").run(siteId, provider);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Pulls a provider's new payments for a site (once at a time: a second call waits for the first). */
  sync(siteId: number, provider: Provider): Promise<SyncResult> {
    const key = `${siteId}:${provider}`;
    const running = this.#running.get(key);
    if (running) return running;
    const run = this.#run(siteId, provider).finally(() => this.#running.delete(key));
    this.#running.set(key, run);
    return run;
  }

  /** Every source of a site, or of every site (the timer). */
  async syncAll(siteId?: number): Promise<SyncResult[]> {
    const rows = (siteId === undefined ? this.#db.prepare("SELECT site_id, provider FROM revenue_sources").all() : this.#db.prepare("SELECT site_id, provider FROM revenue_sources WHERE site_id = ?").all(siteId)) as { site_id: number; provider: Provider }[];
    const out: SyncResult[] = [];
    for (const r of rows) out.push(await this.sync(r.site_id, r.provider));
    return out;
  }

  get busy(): boolean {
    return this.#running.size > 0;
  }

  async #run(siteId: number, provider: Provider): Promise<SyncResult> {
    const src = this.#row(siteId, provider);
    if (!src) return { provider, added: 0, error: "isn't connected to this site" };
    // Its payments come by webhook: nothing to pull.
    if (WEBHOOKS.includes(provider)) return { provider, added: 0 };
    const started = Date.now();
    const since = src.synced_at ? src.synced_at - OVERLAP : started - FIRST_DAYS * DAY;
    let added = 0;
    try {
      const get = this.#client(provider as Pulls, src.mode, this.#open(src.api_key));
      const known = this.#db.prepare("SELECT 1 FROM payments WHERE site_id = ? AND provider = ? AND external_id = ?");
      const pages = provider === "stripe" ? stripe(get, since) : provider === "polar" ? polar(get, since) : provider === "paddle" ? paddle(get, since) : dodo(get, since, (id) => known.get(siteId, provider, id) !== undefined);
      for await (const batch of pages) {
        // Removed while it ran: nothing more to keep.
        if (!this.#row(siteId, provider)) return { provider, added, error: "removed while it synced" };
        added += this.store(siteId, provider, batch);
      }
      this.#db.prepare("UPDATE revenue_sources SET synced_at = ?, sync_error = NULL, error_at = NULL WHERE site_id = ? AND provider = ?").run(started, siteId, provider);
      return { provider, added };
    } catch (err) {
      const message = (err as Error).message;
      this.#db.prepare("UPDATE revenue_sources SET sync_error = ?, error_at = ? WHERE site_id = ? AND provider = ?").run(message, Date.now(), siteId, provider);
      return { provider, added, error: message };
    }
  }

  /** That a site takes this provider's webhooks (before anything of the request is read). */
  expects(siteId: number, provider: string): void {
    if (!WEBHOOKS.includes(provider as Provider)) throw new InputError("provider", "sends no webhooks here", 404);
    if (!this.#row(siteId, provider as Provider)) throw new InputError("provider", "isn't connected to this site", 404);
  }

  /**
   * A webhook from Creem or Lemon Squeezy: checked against the signing secret
   * kept for the site, then its payment kept. One with another signature
   * changes nothing (anyone can send one), so the source keeps waiting.
   */
  receive(siteId: number, provider: string, raw: Buffer, signature: string | undefined): Received {
    this.expects(siteId, provider);
    const p = provider as Provider;
    const src = this.#row(siteId, p)!;
    const want = Buffer.from(createHmac("sha256", this.#open(src.api_key)).update(raw).digest("hex"));
    const given = Buffer.from((signature ?? "").trim().toLowerCase());
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new InputError("signature", "doesn't match the signing secret", 401);
    let body: Json;
    try {
      body = JSON.parse(raw.toString("utf8")) as Json;
    } catch {
      throw new InputError("body", "must be JSON");
    }
    const added = this.store(siteId, p, p === "creem" ? creem(body, src.mode) : lemonsqueezy(body, src.mode));
    this.#db.prepare("UPDATE revenue_sources SET synced_at = ?, sync_error = NULL, error_at = NULL WHERE site_id = ? AND provider = ?").run(Date.now(), siteId, p);
    return { provider: p, added };
  }

  /** Keeps a batch of payments, each credited to its own visit or its customer's first; returns how many are new. */
  store(siteId: number, provider: Provider, batch: Pulled[]): number {
    if (batch.length === 0) return 0;
    this.#flush();
    const db = this.#db;
    const visitOf = db.prepare("SELECT 1 FROM sessions WHERE id = ? AND site_id = ?");
    const known = db.prepare("SELECT 1 FROM payments WHERE site_id = ? AND provider = ? AND external_id = ?");
    const customer = db.prepare(
      `INSERT INTO customers (site_id, provider, customer, visit, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (site_id, provider, customer) DO UPDATE SET visit = excluded.visit, at = excluded.at WHERE excluded.at < customers.at`,
    );
    const payment = db.prepare(
      `INSERT INTO payments (site_id, provider, external_id, at, amount, currency, customer, visit, renewal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, provider, external_id) DO UPDATE SET at = excluded.at, amount = excluded.amount, currency = excluded.currency, customer = coalesce(excluded.customer, payments.customer), visit = coalesce(excluded.visit, payments.visit), renewal = min(payments.renewal, excluded.renewal)`,
    );
    let added = 0;
    db.exec("BEGIN");
    try {
      for (const p of batch) {
        if (!Number.isFinite(p.at)) continue;
        // Only this site's visits: a key shared by two sites lists both sites' payments.
        const visit = p.visit && visitOf.get(p.visit, siteId) ? p.visit : null;
        if (visit && p.customer) customer.run(siteId, provider, p.customer, visit, p.at);
        if (!(p.amount > 0)) continue;
        if (!known.get(siteId, provider, p.id)) added++;
        payment.run(siteId, provider, p.id, p.at, Math.round(p.amount), p.currency.toLowerCase().slice(0, 3), p.customer, visit, p.renewal ? 1 : 0);
      }
      db.prepare(
        `UPDATE payments SET visit = (SELECT c.visit FROM customers c WHERE c.site_id = payments.site_id AND c.provider = payments.provider AND c.customer = payments.customer)
         WHERE site_id = ? AND provider = ? AND visit IS NULL AND customer IS NOT NULL`,
      ).run(siteId, provider);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return added;
  }
}

export interface Received {
  provider: Provider;
  added: number;
}

export interface SyncResult {
  provider: Provider;
  added: number;
  error?: string;
}

/** The currency most of a site's payments are in: totals and breakdowns count that one. */
export function mainCurrency(db: DatabaseSync, siteId: number): string | null {
  const r = db.prepare("SELECT currency FROM payments WHERE site_id = ? GROUP BY currency ORDER BY count(*) DESC, currency LIMIT 1").get(siteId) as { currency: string } | undefined;
  return r?.currency ?? null;
}

export interface RevenueTotals {
  /** In the currency's smallest unit, without tax. */
  amount: number;
  payments: number;
  customers: number;
  /** Of the amount, what's credited to a visit, and what came from renewals. */
  attributed: number;
  renewals: number;
}

export interface RevenueRow {
  /** "" when the visits had none (no referrer, say). */
  name: string;
  amount: number;
  payments: number;
  customers: number;
  /** Visitors who came that way in the range, paying or not. */
  visitors: number;
}

export interface LatestPayment {
  provider: Provider;
  id: string;
  at: number;
  amount: number;
  currency: string;
  renewal: boolean;
  visit: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  entry: string | null;
  country: string | null;
  device: string | null;
}

export interface RevenueStats {
  currency: string | null;
  from: number;
  to: number;
  bucket: "hour" | "day";
  total: RevenueTotals;
  previous: RevenueTotals;
  visitors: number;
  series: { at: number; amount: number; payments: number }[];
  referrers: RevenueRow[];
  utmSources: RevenueRow[];
  utmCampaigns: RevenueRow[];
  entries: RevenueRow[];
  countries: RevenueRow[];
  latest: LatestPayment[];
  /** Payments in other currencies, not in the totals. */
  others: { currency: string; amount: number; payments: number }[];
}

const PAID = "FROM payments p LEFT JOIN sessions s ON s.id = p.visit";

/** Payments (aliased p, their visit s) in a window and currency; a filter leaves out payments with no visit. */
function paymentWhere(siteId: number, from: number, to: number, currency: string | null, f: Filters): { sql: string; args: SQLInputValue[] } {
  const v = visitFilters(f);
  const parts = ["p.site_id = ?", "p.at >= ?", "p.at < ?", ...(currency ? ["p.currency = ?"] : []), ...(v.parts.length ? ["s.id IS NOT NULL", ...v.parts] : [])];
  return { sql: parts.join(" AND "), args: [siteId, from, to, ...(currency ? [currency] : []), ...v.args] };
}

function totals(db: DatabaseSync, siteId: number, from: number, to: number, currency: string, f: Filters): RevenueTotals {
  const w = paymentWhere(siteId, from, to, currency, f);
  return db
    .prepare(
      `SELECT coalesce(sum(p.amount), 0) amount, count(*) payments, count(DISTINCT p.customer) customers,
              coalesce(sum(CASE WHEN p.visit IS NOT NULL THEN p.amount END), 0) attributed, coalesce(sum(CASE WHEN p.renewal = 1 THEN p.amount END), 0) renewals ${PAID} WHERE ${w.sql}`,
    )
    .get(...w.args) as unknown as RevenueTotals;
}

const NONE: RevenueTotals = { amount: 0, payments: 0, customers: 0, attributed: 0, renewals: 0 };

/** For the Overview: revenue in the range and the one before, in the main currency; null with no payments at all. */
export function revenueSummary(db: DatabaseSync, siteId: number, o: { range: Range; filters?: Filters; now?: number }): { currency: string; total: RevenueTotals; previous: RevenueTotals } | null {
  const currency = mainCurrency(db, siteId);
  if (!currency) return null;
  const { from, to } = windowOf(o.range, o.now ?? Date.now());
  const f = o.filters ?? {};
  return { currency, total: totals(db, siteId, from, to, currency, f), previous: totals(db, siteId, from - (to - from), from, currency, f) };
}

export function revenueStats(db: DatabaseSync, siteId: number, o: { range: Range; filters?: Filters; now?: number }): RevenueStats {
  const now = o.now ?? Date.now();
  const f = o.filters ?? {};
  const { from, to, bucket } = windowOf(o.range, now);
  const currency = mainCurrency(db, siteId);
  const vi = visitWhere(siteId, from, to, f);
  const visitors = (db.prepare(`SELECT count(DISTINCT s.visitor) n FROM sessions s WHERE ${vi.sql}`).get(...vi.args) as { n: number }).n;
  const size = bucket === "hour" ? HOUR : DAY;
  const series = new Map<number, { amount: number; payments: number }>();
  for (let at = from; at < to; at += size) series.set(at, { amount: 0, payments: 0 });
  const empty: RevenueStats = { currency, from, to: now, bucket, total: NONE, previous: NONE, visitors, series: [...series].map(([at, p]) => ({ at, ...p })), referrers: [], utmSources: [], utmCampaigns: [], entries: [], countries: [], latest: [], others: [] };
  if (!currency) return empty;

  const w = paymentWhere(siteId, from, to, currency, f);
  for (const r of db.prepare(`SELECT (p.at / ${size}) * ${size} b, sum(p.amount) amount, count(*) payments ${PAID} WHERE ${w.sql} GROUP BY b`).all(...w.args) as { b: number; amount: number; payments: number }[]) {
    const p = series.get(r.b);
    if (p) Object.assign(p, { amount: r.amount, payments: r.payments });
  }
  const rows = (column: string): RevenueRow[] => {
    const seen = new Map((db.prepare(`SELECT coalesce(s.${column}, '') name, count(DISTINCT s.visitor) n FROM sessions s WHERE ${vi.sql} GROUP BY name`).all(...vi.args) as { name: string; n: number }[]).map((r) => [r.name, r.n]));
    return (
      db
        .prepare(`SELECT coalesce(s.${column}, '') name, sum(p.amount) amount, count(*) payments, count(DISTINCT p.customer) customers ${PAID} WHERE ${w.sql} AND s.id IS NOT NULL GROUP BY name ORDER BY amount DESC, name LIMIT 50`)
        .all(...w.args) as unknown as Omit<RevenueRow, "visitors">[]
    ).map((r) => ({ ...r, visitors: seen.get(r.name) ?? 0 }));
  };
  const all = paymentWhere(siteId, from, to, null, f);
  const latest = (
    db
      .prepare(
        `SELECT p.provider, p.external_id id, p.at, p.amount, p.currency, p.renewal, p.visit, s.referrer, s.utm_source utmSource, s.utm_campaign utmCampaign, s.entry, s.country, s.device
         ${PAID} WHERE ${all.sql} ORDER BY p.at DESC LIMIT 50`,
      )
      .all(...all.args) as unknown as (Omit<LatestPayment, "renewal"> & { renewal: number })[]
  ).map((r) => ({ ...r, renewal: r.renewal === 1 }));
  const others = db
    .prepare(`SELECT p.currency, sum(p.amount) amount, count(*) payments ${PAID} WHERE ${all.sql} AND p.currency != ? GROUP BY p.currency ORDER BY payments DESC`)
    .all(...all.args, currency) as unknown as RevenueStats["others"];
  return {
    ...empty,
    total: totals(db, siteId, from, to, currency, f),
    previous: totals(db, siteId, from - (to - from), from, currency, f),
    series: [...series].map(([at, p]) => ({ at, ...p })),
    referrers: rows("referrer"),
    utmSources: rows("utm_source"),
    utmCampaigns: rows("utm_campaign"),
    entries: rows("entry"),
    countries: rows("country"),
    latest,
    others,
  };
}
