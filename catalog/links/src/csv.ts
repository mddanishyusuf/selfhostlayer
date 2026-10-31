// CSV export, and import from Links or another shortener: columns are matched
// by name (url, long_url, destination…; slug, keyword, back_half…), so most
// exports work as they are. A row that can't be a link is skipped with the
// reason, never half-imported.
import { csvCell as cell, parseCsv } from "../../lib/csv.ts";
import type { Link, Store } from "./store.ts";
import { InputError } from "./validate.ts";

const COLUMNS = ["slug", "target", "title", "tags", "redirect", "pass_query", "expires_at", "disabled", "clicks", "created_at"] as const;

export { parseCsv };

export function toCsv(links: Link[]): string {
  const rows = links.map((l) =>
    [l.slug, l.target, l.title, l.tags.join("|"), String(l.redirect), l.passQuery ? "true" : "false", l.expiresAt ? new Date(l.expiresAt).toISOString() : "", l.disabled ? "true" : "false", String(l.clicks), new Date(l.createdAt).toISOString()]
      .map(cell)
      .join(","),
  );
  return `${[COLUMNS.join(","), ...rows].join("\n")}\n`;
}

const NAMES: Record<string, string[]> = {
  target: ["target", "url", "long_url", "longurl", "long url", "destination", "original_url", "original url", "link"],
  slug: ["slug", "keyword", "alias", "back_half", "backhalf", "back-half", "custom", "code", "short"],
  title: ["title", "name"],
  tags: ["tags", "tag"],
  redirect: ["redirect", "status"],
  passQuery: ["pass_query", "passquery"],
  expiresAt: ["expires_at", "expires", "expiry"],
  disabled: ["disabled"],
};

export const MAX_IMPORT_ROWS = 10_000;

export function importCsv(store: Store, text: string): { created: number; skipped: { line: number; reason: string }[] } {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new InputError("csv", "the file is empty");
  if (rows.length > MAX_IMPORT_ROWS) throw new InputError("csv", `at most ${MAX_IMPORT_ROWS} links at a time`);
  const names = header.map((h) => h.trim().toLowerCase());
  const index = Object.fromEntries(Object.entries(NAMES).map(([field, aliases]) => [field, names.findIndex((n) => aliases.includes(n))]));
  if (index.target === -1) throw new InputError("csv", "no column with the target URL (named url, target, long_url or destination)");
  let created = 0;
  const skipped: { line: number; reason: string }[] = [];
  rows.forEach((row, i) => {
    const get = (field: string) => {
      const at = index[field] ?? -1;
      const v = at >= 0 ? row[at]?.trim() : undefined;
      return v === "" ? undefined : v;
    };
    try {
      store.create({ target: get("target"), slug: get("slug"), title: get("title"), tags: get("tags"), redirect: get("redirect"), passQuery: get("passQuery"), expiresAt: get("expiresAt"), disabled: get("disabled") });
      created++;
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      skipped.push({ line: i + 2, reason: `${err.field}: ${err.message}` });
    }
  });
  return { created, skipped };
}
