// The admin API, /_admin/…, for the panel: forms, their responses (files
// included), insights and notifications, and how emails go out. It answers
// only requests made on this server with the token made at install
// (FORMS_ADMIN_TOKEN); anything through Caddy, which always sets
// X-Forwarded-For, is told it doesn't exist. Every request also says where
// Forms is reachable (X-Public-Url), which the forms' links use.
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { bearer, InputError, json, readJson, send } from "../../lib/http.ts";
import type { Forms } from "./forms.ts";
import type { Notifier } from "./notify.ts";
import type { Responses } from "./responses.ts";

export interface AdminContext {
  forms: Forms;
  responses: Responses;
  notifier: Notifier;
  token: string;
  version: string;
  publicUrl: () => string;
  setPublicUrl: (url: string) => void;
  /** For the builder's preview: ?preview=<this> shows the form even closed, and keeps nothing. */
  previewToken: (slug: string) => string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const authorized = (req: IncomingMessage, token: string) => {
  const given = bearer(req);
  return given !== null && timingSafeEqual(digest(given), digest(token));
};

type Handler = (a: { req: IncomingMessage; res: ServerResponse; ctx: AdminContext; p: Record<string, string>; q: URLSearchParams; body: () => Promise<Record<string, unknown>> }) => Promise<unknown> | unknown;
const id = (v: string | undefined, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InputError(what, `no such ${what}`, 404);
  return n;
};

const ROUTES: [string, string, Handler][] = [
  ["GET", "info", ({ ctx }) => ({ version: ctx.version, publicUrl: ctx.publicUrl(), forms: ctx.forms.list().length })],
  ["GET", "settings", ({ ctx }) => ({ email: ctx.notifier.emailConfig() })],
  ["PUT", "settings", async ({ ctx, body }) => (ctx.notifier.setEmail((await body()).email ?? null), { email: ctx.notifier.emailConfig() })],
  ["GET", "forms", ({ ctx }) => ({ forms: ctx.forms.list().map((f) => ({ ...f, closed: ctx.forms.closedBecause(f) })) })],
  ["POST", "forms", async ({ ctx, body }) => ctx.forms.add(await body())],
  [
    "GET",
    "forms/:id",
    ({ ctx, p }) => {
      const form = ctx.forms.get(id(p.id, "form"));
      return { form, closed: ctx.forms.closedBecause(form), deliveries: ctx.notifier.recent(form.id), preview: ctx.previewToken(form.slug) };
    },
  ],
  ["PATCH", "forms/:id", async ({ ctx, p, body }) => ctx.forms.update(id(p.id, "form"), await body())],
  [
    "DELETE",
    "forms/:id",
    ({ ctx, p }) => {
      const formId = id(p.id, "form");
      ctx.forms.get(formId);
      ctx.responses.removeAll(formId);
      ctx.forms.remove(formId);
      return { deleted: true };
    },
  ],
  ["POST", "forms/:id/duplicate", ({ ctx, p }) => ctx.forms.duplicate(id(p.id, "form"))],
  ["POST", "forms/:id/test-webhook", ({ ctx, p }) => ctx.notifier.testWebhook(ctx.forms.get(id(p.id, "form")))],
  ["GET", "forms/:id/insights", ({ ctx, p, q }) => ctx.responses.insights(ctx.forms.get(id(p.id, "form")), Math.min(90, Math.max(1, Number(q.get("days")) || 30)))],
  ["GET", "forms/:id/responses", ({ ctx, p, q }) => ctx.responses.list(ctx.forms.get(id(p.id, "form")).id, { q: q.get("q") ?? undefined, page: Number(q.get("page")) || 1 })],
  ["GET", "forms/:id/responses/:rid", ({ ctx, p }) => ctx.responses.get(id(p.id, "form"), id(p.rid, "response"))],
  ["DELETE", "forms/:id/responses/:rid", ({ ctx, p }) => (ctx.responses.remove(id(p.id, "form"), id(p.rid, "response")), { deleted: true })],
  ["DELETE", "forms/:id/responses", ({ ctx, p }) => ({ deleted: ctx.responses.removeAll(ctx.forms.get(id(p.id, "form")).id) })],
  [
    "GET",
    "forms/:id/export",
    ({ ctx, p, res }) => {
      send(res, 200, ctx.responses.csv(ctx.forms.get(id(p.id, "form"))), { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" });
      return undefined;
    },
  ],
  [
    "GET",
    "forms/:id/files/:file",
    ({ ctx, p, res }) => {
      const f = ctx.responses.file(id(p.id, "form"), p.file!);
      res.writeHead(200, { "Content-Type": f.type, "Content-Length": String(f.size), "Content-Disposition": `attachment; filename="${f.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      createReadStream(f.path).pipe(res);
      return undefined;
    },
  ],
];

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, ctx: AdminContext, url: URL): Promise<void> {
  if (req.headers["x-forwarded-for"] !== undefined) return json(res, 404, { error: "not found" });
  if (!authorized(req, ctx.token)) return json(res, 401, { error: "the admin token is missing or wrong" });
  const told = req.headers["x-public-url"];
  if (typeof told === "string" && /^https?:\/\/[^\s/]+$/.test(told) && told !== ctx.publicUrl()) ctx.setPublicUrl(told);
  const parts = url.pathname.split("/").slice(2).filter(Boolean);
  for (const [method, pattern, handler] of ROUTES) {
    if (method !== (req.method ?? "GET")) continue;
    const want = pattern.split("/");
    if (want.length !== parts.length) continue;
    const p: Record<string, string> = {};
    if (!want.every((w, i) => (w.startsWith(":") ? ((p[w.slice(1)] = decodeURIComponent(parts[i]!)), true) : w === parts[i]))) continue;
    const out = await handler({ req, res, ctx, p, q: url.searchParams, body: () => readJson(req, 4 * 1024 * 1024) });
    if (!res.headersSent) json(res, 200, out ?? {});
    return;
  }
  json(res, 404, { error: "not found" });
}
