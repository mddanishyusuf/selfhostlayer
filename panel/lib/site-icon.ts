// Site icons for project marks: a project whose own domain is live shows that
// site's favicon instead of its letter. The panel fetches it from Google's
// favicon service, so browsers only ever talk to the panel, and keeps it a day.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config";
import { listDomains } from "./domains";
import { getProjectBySlug } from "./projects";

const FOUND_MS = 24 * 3600_000;
// A site without an icon (or Google out of reach) is asked again after this.
const MISSING_MS = 6 * 3600_000;
const MAX_BYTES = 256 * 1024;

const dir = () => join(dirname(config.dbPath), "site-icons");
const iconFile = (host: string) => join(dir(), `${host}.png`);
const missingFile = (host: string) => join(dir(), `${host}.missing`);
const fresh = (file: string, ms: number) => existsSync(file) && Date.now() - statSync(file).mtimeMs < ms;

/** The domain a project's icon comes from: its own live domain, not the free URL. */
export function iconHost(projectId: number): string | null {
  return listDomains(projectId).find((d) => d.role === "primary" && d.status === "active")?.host ?? null;
}

/** The icon's URL for a project's mark, unless it has no live domain or its site has no icon. */
export function projectIconUrl(slug: string): string | undefined {
  const project = getProjectBySlug(slug);
  const host = project ? iconHost(project.id) : null;
  if (!host || fresh(missingFile(host), MISSING_MS)) return undefined;
  return `/api/projects/${slug}/icon`;
}

/** The site's icon (a PNG), fetched once a day. Null when it has none. */
export async function siteIcon(host: string): Promise<Buffer | null> {
  if (fresh(iconFile(host), FOUND_MS)) return readFileSync(iconFile(host));
  if (fresh(missingFile(host), MISSING_MS)) return null;
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  try {
    // Google answers 404 (with a generic globe) when it knows no icon for the site.
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`, { signal: AbortSignal.timeout(5000) });
    const body = Buffer.from(await res.arrayBuffer());
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/") || body.length === 0 || body.length > MAX_BYTES) throw new Error("no icon");
    writeFileSync(iconFile(host), body, { mode: 0o600 });
    rmSync(missingFile(host), { force: true });
    return body;
  } catch {
    // Keep a stale icon over none when Google is out of reach.
    if (existsSync(iconFile(host))) return readFileSync(iconFile(host));
    writeFileSync(missingFile(host), "", { mode: 0o600 });
    return null;
  }
}
