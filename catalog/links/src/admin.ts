// The admin API, /_admin/…, for the panel: links, stats, settings, API
// tokens, CSV. It answers only requests made on this server with the token
// made at install (LINKS_ADMIN_TOKEN); anything through Caddy, which always
// sets X-Forwarded-For, is told it doesn't exist.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { importCsv, toCsv } from "./csv.ts";
import { bearer, json, readBody, readJson, send } from "./http.ts";
import type { PublicContext } from "./redirect.ts";
import type { Settings } from "./settings.ts";
import { RANGES, stats, type Range } from "./stats.ts";
import { toPublic } from "./store.ts";
import { createToken, listTokens, revokeToken } from "./tokens.ts";
import { InputError } from "./validate.ts";

export interface AdminContext extends PublicContext {
  db: DatabaseSync;
  token: string;
  version: string;
  geoSource: () => string | null;
  saveSettings: (input: Record<string, unknown>) => Settings;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const authorized = (req: IncomingMessage, token: string) => {
  const given = bearer(req);
  return given !== null && timingSafeEqual(digest(given), digest(token));
};

const idOf = (text: string | undefined): number => {
  const id = Number(text);
  if (!Number.isInteger(id) || id < 1) throw new InputError("id", "no such link", 404);
  return id;
};

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, ctx: AdminContext, url: URL): Promise<void> {
  if (req.headers["x-forwarded-for"] !== undefined) return json(res, 404, { error: "not found" });
  if (!authorized(req, ctx.token)) return json(res, 401, { error: "the admin token is missing or wrong" });
  const [, , section, idText] = url.pathname.split("/");
  const method = req.method ?? "GET";
  const p = url.searchParams;
  const route = `${method} ${section ?? ""}${idText !== undefined ? "/:id" : ""}`;
  switch (route) {
    case "GET info":
      return json(res, 200, { version: ctx.version, links: ctx.store.size, geo: ctx.geoSource(), pendingClicks: ctx.clicks.pending });
    case "GET links": {
      const sort = p.get("sort");
      const { links, total } = ctx.store.list({
        q: p.get("q") ?? undefined,
        tag: p.get("tag") ?? undefined,
        sort: sort === "clicks" || sort === "slug" ? sort : "created",
        limit: Number(p.get("limit") ?? 50),
        offset: Number(p.get("offset") ?? 0),
      });
      return json(res, 200, { links: links.map(toPublic), total, tags: ctx.store.tags() });
    }
    case "POST links":
      return json(res, 201, toPublic(ctx.store.create(await readJson(req))));
    case "GET links/:id": {
      const link = ctx.store.byId(idOf(idText));
      if (!link) throw new InputError("id", "no such link", 404);
      return json(res, 200, toPublic(link));
    }
    case "PATCH links/:id":
      return json(res, 200, toPublic(ctx.store.update(idOf(idText), await readJson(req))));
    case "DELETE links/:id":
      ctx.store.remove(idOf(idText));
      return json(res, 200, { deleted: true });
    case "GET stats": {
      const range = p.get("range") ?? "7d";
      if (!(RANGES as readonly string[]).includes(range)) throw new InputError("range", `must be one of ${RANGES.join(", ")}`);
      const linkId = p.get("link") ? idOf(p.get("link")!) : undefined;
      // Clicks still in memory count too.
      ctx.clicks.flush();
      return json(res, 200, stats(ctx.db, ctx.store, { range: range as Range, linkId, bots: p.get("bots") === "1" }));
    }
    case "GET settings":
      return json(res, 200, ctx.settings());
    case "PUT settings":
      return json(res, 200, ctx.saveSettings(await readJson(req)));
    case "GET tokens":
      return json(res, 200, { tokens: listTokens(ctx.db) });
    case "POST tokens": {
      const { token, info } = createToken(ctx.db, (await readJson(req)).name);
      return json(res, 201, { ...info, token });
    }
    case "DELETE tokens/:id":
      revokeToken(ctx.db, idOf(idText));
      return json(res, 200, { deleted: true });
    case "GET export":
      return send(res, 200, toCsv(ctx.store.list({ sort: "created", limit: 1_000_000 }).links), {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="links.csv"',
        "Cache-Control": "no-store",
      });
    case "POST import":
      return json(res, 200, importCsv(ctx.store, (await readBody(req, 5 * 1024 * 1024)).toString("utf8")));
    default:
      return json(res, 404, { error: "not found" });
  }
}
