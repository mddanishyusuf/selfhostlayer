// The public API on the short domain, for scripts and other apps:
//   GET|POST /api/v1/links          list (q, tag, sort, limit, offset) or create
//   GET|PATCH|DELETE /api/v1/links/<slug>
// with a token made in the panel (Authorization: Bearer lk_…), each token
// limited to 120 requests a minute.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminContext } from "./admin.ts";
import { bearer, json, readJson } from "./http.ts";
import { toPublic, type Link } from "./store.ts";
import { useToken } from "./tokens.ts";
import { InputError } from "./validate.ts";

export const API_LIMIT = 120;
const windows = new Map<number, { n: number; reset: number }>();

/** Whether the token is over its limit this minute (and when it may try again). */
function limited(tokenId: number, now: number): number | null {
  const w = windows.get(tokenId);
  if (!w || w.reset <= now) {
    windows.set(tokenId, { n: 1, reset: now + 60_000 });
    return null;
  }
  return ++w.n > API_LIMIT ? Math.ceil((w.reset - now) / 1000) : null;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: AdminContext, url: URL): Promise<void> {
  const [api, v1, links, slugText, ...rest] = url.pathname.split("/").filter(Boolean);
  if (api !== "api" || v1 !== "v1" || links !== "links" || rest.length) return json(res, 404, { error: "not found" });
  const token = bearer(req);
  const info = token ? useToken(ctx.db, token) : null;
  if (!info) return json(res, 401, { error: "an API token is needed: Authorization: Bearer lk_…" });
  const wait = limited(info.id, Date.now());
  if (wait !== null) {
    res.setHeader("Retry-After", String(wait));
    return json(res, 429, { error: `over ${API_LIMIT} requests a minute; try again in ${wait}s` });
  }
  const host = req.headers.host;
  const shape = (l: Link) => ({ ...toPublic(l), shortUrl: host ? `https://${host}/${l.slug}` : null });
  const method = req.method ?? "GET";
  if (slugText === undefined) {
    if (method === "GET") {
      const p = url.searchParams;
      const sort = p.get("sort");
      const { links: found, total } = ctx.store.list({
        q: p.get("q") ?? undefined,
        tag: p.get("tag") ?? undefined,
        sort: sort === "clicks" || sort === "slug" ? sort : "created",
        limit: Number(p.get("limit") ?? 50),
        offset: Number(p.get("offset") ?? 0),
      });
      return json(res, 200, { links: found.map(shape), total });
    }
    if (method === "POST") return json(res, 201, shape(ctx.store.create(await readJson(req))));
    return json(res, 405, { error: "use GET or POST" });
  }
  let slug: string;
  try {
    slug = decodeURIComponent(slugText);
  } catch {
    throw new InputError("slug", "no such link", 404);
  }
  const link = ctx.store.bySlug(slug);
  if (!link) throw new InputError("slug", "no such link", 404);
  if (method === "GET") return json(res, 200, shape(link));
  if (method === "PATCH") return json(res, 200, shape(ctx.store.update(link.id, await readJson(req))));
  if (method === "DELETE") {
    ctx.store.remove(link.id);
    return json(res, 200, { deleted: true });
  }
  return json(res, 405, { error: "use GET, PATCH or DELETE" });
}
