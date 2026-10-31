// The integrations catalog: first-party apps the panel installs like projects,
// from a tarball instead of a GitHub repo. Where the catalog lives comes from
// /etc/layer/config.json (catalogUrl, or catalog.json next to the update feed),
// so the panel only picks an app and a version, never where it comes from.
// Every tarball must sit on the catalog's own origin and match its sha256;
// catalog.fetch (build.ts) checks that before anything is unpacked.
import { parseManifest, ValidationError, type AppManifest } from "@layer/protocol";
import type { ActionTable, Context } from "../context.ts";
import { ActionError } from "../errors.ts";
import { readBox, type BoxFile } from "./panel.ts";
import { assertReleaseUrl } from "./update.ts";

const ID = /^[a-z](?:[a-z0-9-]{0,29}[a-z0-9])$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

export interface CatalogVersion {
  version: string;
  date: string | null;
  notes: string | null;
  /** The oldest panel version that can install it. */
  minPanel: string | null;
  tarball: { url: string; sha256: string };
  manifest: AppManifest;
}

export interface CatalogApp {
  id: string;
  name: string;
  summary: string;
  /** Newest first. */
  versions: CatalogVersion[];
}

/** catalogUrl, or catalog.json beside the update feed (get.selfhostlayer.com/catalog.json). */
export function catalogUrl(box: BoxFile): string {
  if (box.catalogUrl) return assertReleaseUrl(box.catalogUrl, "catalogUrl");
  if (box.updatesUrl) return assertReleaseUrl(new URL("catalog.json", box.updatesUrl).href, "catalogUrl");
  throw new ActionError("not_configured", "this server has no catalog (catalogUrl or updatesUrl in /etc/layer/config.json)");
}

/**
 * { apps: [{ id, name, summary, versions: [{ version, date?, notes?, minPanel?, tarball: { url, sha256 }, manifest }] }] },
 * checked. Tarballs must share the catalog's origin, and each manifest must name its app and version.
 */
export function parseCatalog(text: string, from: string): CatalogApp[] {
  let catalog: { apps?: unknown };
  try {
    catalog = JSON.parse(text) as { apps?: unknown };
  } catch {
    throw new ActionError("bad_catalog", "the catalog isn't JSON");
  }
  if (!Array.isArray(catalog.apps)) throw new ActionError("bad_catalog", "the catalog has no apps list");
  if (catalog.apps.length > 200) throw new ActionError("bad_catalog", "the catalog lists too many apps");
  const origin = new URL(from).origin;
  return catalog.apps.map((a: Record<string, any>, i) => {
    const at = `apps[${i}]`;
    if (typeof a?.id !== "string" || !ID.test(a.id)) throw new ValidationError(`${at}.id`, "must be an app id like links");
    if (!Array.isArray(a.versions) || !a.versions.length || a.versions.length > 100) throw new ValidationError(`${at}.versions`, "must list 1 to 100 versions");
    const versions = a.versions.map((v: Record<string, any>, j: number): CatalogVersion => {
      const vat = `${at}.versions[${j}]`;
      if (typeof v?.version !== "string" || !VERSION.test(v.version)) throw new ValidationError(`${vat}.version`, "must be a version like 0.1.0");
      const sha256 = v.tarball?.sha256;
      if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new ValidationError(`${vat}.tarball.sha256`, "must be a sha256 in hex");
      const url = assertReleaseUrl(v.tarball?.url, `${vat}.tarball.url`);
      if (new URL(url).origin !== origin) throw new ValidationError(`${vat}.tarball.url`, `must be on the catalog's own address (${origin})`);
      let manifest: AppManifest;
      try {
        manifest = parseManifest(v.manifest);
      } catch (err) {
        if (err instanceof ValidationError) throw new ValidationError(`${vat}.manifest.${err.field}`, err.message.slice(err.field.length + 2));
        throw err;
      }
      if (manifest.id !== a.id || manifest.version !== v.version) throw new ValidationError(`${vat}.manifest`, `must describe ${a.id} ${v.version}`);
      if (v.minPanel !== undefined && (typeof v.minPanel !== "string" || !VERSION.test(v.minPanel))) throw new ValidationError(`${vat}.minPanel`, "must be a version like 0.2.0");
      return {
        version: v.version,
        date: typeof v.date === "string" ? v.date.slice(0, 40) : null,
        notes: typeof v.notes === "string" ? v.notes.slice(0, 2000) : null,
        minPanel: v.minPanel ?? null,
        tarball: { url, sha256 },
        manifest,
      };
    });
    const latest = versions[0]!.manifest;
    return { id: a.id, name: latest.name, summary: latest.summary, versions };
  });
}

export async function readCatalog(ctx: Context): Promise<{ url: string; apps: CatalogApp[] }> {
  const url = catalogUrl(readBox(ctx));
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  } catch (err) {
    throw new ActionError("download_failed", `couldn't reach the catalog (${(err as Error).message})`);
  }
  if (!res.ok) throw new ActionError("download_failed", `the catalog answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_CATALOG_BYTES) throw new ActionError("bad_catalog", "the catalog is too big");
  return { url, apps: parseCatalog(text, url) };
}

/** One app's version from the catalog, or a clear error. */
export async function catalogVersion(ctx: Context, app: string, version: string): Promise<CatalogVersion> {
  if (!ID.test(app)) throw new ValidationError("app", "must be an app id like links");
  if (!VERSION.test(version)) throw new ValidationError("version", "must be a version like 0.1.0");
  const { apps } = await readCatalog(ctx);
  const found = apps.find((a) => a.id === app);
  if (!found) throw new ActionError("not_found", `the catalog has no app ${app}`);
  const v = found.versions.find((x) => x.version === version);
  if (!v) throw new ActionError("not_found", `the catalog has no ${app} ${version}`);
  return v;
}

/** The catalog for the panel: apps, versions and manifests (not where tarballs live). */
async function catalogList(_params: unknown, ctx: Context) {
  const { apps } = await readCatalog(ctx);
  return {
    apps: apps.map((a) => ({
      id: a.id,
      name: a.name,
      summary: a.summary,
      versions: a.versions.map(({ tarball, ...v }) => ({ ...v, sha256: tarball.sha256 })),
    })),
  };
}

export const catalogActions: ActionTable = {
  "catalog.list": { mutates: false, run: catalogList },
};
