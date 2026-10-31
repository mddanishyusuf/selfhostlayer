// Email as one HTTP server: /healthz, the public routes (tracking,
// unsubscribe, subscribe, SES's webhook), the API apps call with a key, and the
// admin API (/_admin/…, this server only). In the background: the worker
// sends the queue, campaigns start and finish, automations move along.
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fail, json, send } from "../../lib/http.ts";
import { handleAdmin, type AdminContext } from "./admin.ts";
import { ApiKeys, handleApi, type ApiContext } from "./api.ts";
import { Automations } from "./automations.ts";
import { Brands } from "./brands.ts";
import { Campaigns } from "./campaigns.ts";
import { Contacts } from "./contacts.ts";
import { getSetting, openDb, setSetting } from "./db.ts";
import { Domains, type Dns } from "./domains.ts";
import { Mailer } from "./mailer.ts";
import { handlePublic, type PublicContext } from "./public.ts";
import { Secrets } from "../../lib/secrets.ts";
import { Templates } from "./templates.ts";

export interface AppOptions {
  dataDir: string;
  /** The admin API's token (EMAIL_ADMIN_TOKEN); secrets at rest are encrypted under a key made from it. */
  token: string;
  /** Signs links in emails (EMAIL_SECRET). */
  secret: string;
  version: string;
  /** false: nothing runs in the background (tests drive it by hand). */
  background?: boolean;
  // Tests: other ways out.
  fetch?: typeof fetch;
  awsEndpoint?: string;
  smtpCa?: string;
  dns?: Dns;
  snsCertificate?: string;
}

export interface App {
  server: Server;
  db: DatabaseSync;
  brands: Brands;
  domains: Domains;
  contacts: Contacts;
  campaigns: Campaigns;
  templates: Templates;
  automations: Automations;
  mailer: Mailer;
  keys: ApiKeys;
  publicUrl: () => string;
  close: () => Promise<void>;
}

export function createApp(o: AppOptions): App {
  mkdirSync(o.dataDir, { recursive: true });
  const db = openDb(join(o.dataDir, "email.db"));
  const secrets = new Secrets(o.token, o.secret, "email");
  let publicUrl = getSetting(db, "publicUrl") ?? "http://127.0.0.1";
  const setPublicUrl = (url: string) => {
    publicUrl = url;
    setSetting(db, "publicUrl", url);
  };
  const hostName = () => new URL(publicUrl).hostname;
  let brands!: Brands;
  const domains = new Domains({ db, secrets, brands: () => brands, dns: o.dns });
  brands = new Brands({ db, secrets, dkim: (id) => domains.dkimFor(id), hostName, fetch: o.fetch, awsEndpoint: o.awsEndpoint, smtpCa: o.smtpCa });
  const contacts = new Contacts(db);
  const mailer = new Mailer({ db, brands, domains, contacts, secrets, publicUrl: () => publicUrl });
  const campaigns = new Campaigns({ db, brands, domains, contacts });
  const templates = new Templates(db);
  const automations = new Automations({ db, brands, domains, contacts, mailer });
  contacts.hooks.joined = (brandId, listId, contactId) => automations.onListJoin(brandId, listId, contactId);
  const keys = new ApiKeys(db);

  const admin: AdminContext = { db, brands, domains, contacts, campaigns, templates, automations, mailer, keys, token: o.token, version: o.version, publicUrl: () => publicUrl, setPublicUrl, smtpCa: o.smtpCa };
  const api: ApiContext = { db, brands, domains, contacts, templates, automations, mailer, keys };
  const pub: PublicContext = { db, brands, domains, contacts, mailer, secrets, publicUrl: () => publicUrl, fetch: o.fetch, snsCertificate: o.snsCertificate };

  const timers: NodeJS.Timeout[] = [];
  if (o.background !== false) {
    mailer.start();
    const every = (ms: number, run: () => void, what: string) => {
      const t = setInterval(() => {
        try {
          run();
        } catch (err) {
          console.error(`${what} failed: ${(err as Error).message}`);
        }
      }, ms);
      t.unref();
      timers.push(t);
    };
    every(5000, () => campaigns.tick(), "starting campaigns");
    every(15_000, () => automations.tick(), "moving automations along");
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://email");
    const run = async () => {
      if (url.pathname === "/healthz") return send(res, 200, "ok\n", { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      if (url.pathname === "/_admin" || url.pathname.startsWith("/_admin/")) return handleAdmin(req, res, admin, url);
      if (await handleApi(req, res, api, url)) return;
      if (await handlePublic(req, res, pub, url)) return;
      if (url.pathname === "/") return send(res, 200, "Email by Self Host Layer: this address takes the API's requests, and the clicks and unsubscribes from its emails.\n", { "Content-Type": "text/plain; charset=utf-8" });
      json(res, 404, { error: "not found" });
    };
    run().catch((err: unknown) => fail(res, err));
  });
  server.keepAliveTimeout = 65_000;

  return {
    server,
    db,
    brands,
    domains,
    contacts,
    campaigns,
    templates,
    automations,
    mailer,
    keys,
    publicUrl: () => publicUrl,
    close: async () => {
      for (const t of timers) clearInterval(t);
      await mailer.stop();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeIdleConnections();
      });
      await brands.closeAll();
      db.close();
    },
  };
}
