// A picture of each project's live site for its Overview: the image the site
// offers for link previews (og:image or twitter:image), fetched by the panel
// and kept on disk until the next deploy. No headless browser, so nothing to
// install and no memory spike after deploys, and the app's JavaScript never
// runs (looking at the panel doesn't count as a visit in its analytics).
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { config } from "./config";

export interface SitePreview {
  /** The live deployment it was taken for: a new deploy takes a new one. */
  deploymentId: number;
  url: string;
  title: string | null;
  description: string | null;
  /** The image's file name in the previews folder, when the site offers one. */
  image: string | null;
  /** Set when the site couldn't be read; tried again after RETRY_MS. */
  error?: string;
  fetchedAt: number;
}

export interface PreviewMeta {
  title: string | null;
  description: string | null;
  image: string | null;
}

// Raster only: an SVG served from the panel's origin could run script.
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
const PAGE_BYTES = 512 * 1024;
const IMAGE_BYTES = 4 * 1024 * 1024;
const RETRY_MS = 10 * 60_000;
const USER_AGENT = "Mozilla/5.0 (compatible; SelfHostLayer/1.0; +https://selfhostlayer.com)";
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const dir = () => join(config.dataDir, "previews");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Title, description and preview image from a page's <head>. The image URL is made absolute against the page's URL. */
export function parsePreviewMeta(html: string, pageUrl: string): PreviewMeta {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs.set(m[1]!.toLowerCase(), decode((m[2] ?? m[3] ?? m[4] ?? "").trim()));
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title\b[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v);
  let image: string | null = null;
  const raw = first("og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src");
  if (raw) {
    try {
      const u = new URL(raw, pageUrl);
      if (u.protocol === "https:" || u.protocol === "http:") image = u.href;
    } catch {
      // not a URL
    }
  }
  const clip = (s: string | undefined, n: number) => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) || null : null);
  return { title: clip(first("og:title", "twitter:title") ?? (titleTag ? decode(titleTag) : undefined), 120), description: clip(first("og:description", "twitter:description", "description"), 240), image };
}

/** Loopback, private, link-local (cloud metadata lives there), CGNAT, multicast and other non-public addresses. */
export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return false;
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff")) return false;
    return true;
  }
  return false;
}

/**
 * The page and its image come from wherever the site says, and the site may
 * be compromised: only the project's own domains (served by this box) or
 * hosts with public addresses are fetched.
 */
async function assertFetchable(url: URL, own: string[]): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`refusing ${url.protocol} URLs`);
  if (own.includes(url.hostname)) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error(`${url.hostname} isn't a public address`);
}

/** GET with redirects checked hop by hop, a timeout, and a byte limit (the rest is dropped). */
async function fetchLimited(start: string, own: string[], maxBytes: number, timeoutMs: number): Promise<{ url: string; type: string; body: Buffer }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = new URL(start);
  for (let hop = 0; hop < 5; hop++) {
    await assertFetchable(url, own);
    const res = await fetch(url, { redirect: "manual", signal, headers: { "User-Agent": USER_AGENT, Accept: "text/html,image/*;q=0.9,*/*;q=0.5" } });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`${url.host} answered ${res.status}`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      chunks.push(Buffer.from(chunk));
      size += chunk.byteLength;
      if (size >= maxBytes) break;
    }
    return { url: url.href, type: (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(), body: Buffer.concat(chunks).subarray(0, maxBytes) };
  }
  throw new Error("too many redirects");
}

async function take(slug: string, deploymentId: number, url: string, own: string[]): Promise<SitePreview> {
  const base: SitePreview = { deploymentId, url, title: null, description: null, image: null, fetchedAt: Date.now() };
  let preview: SitePreview;
  try {
    const page = await fetchLimited(url, own, PAGE_BYTES, 6000);
    const meta = page.type.includes("html") ? parsePreviewMeta(page.body.toString("utf8"), page.url) : { title: null, description: null, image: null };
    preview = { ...base, title: meta.title, description: meta.description };
    if (meta.image) {
      const img = await fetchLimited(meta.image, own, IMAGE_BYTES + 1, 8000).catch(() => null);
      const ext = img ? IMAGE_TYPES[img.type] : undefined;
      if (img && ext && img.body.length <= IMAGE_BYTES) {
        preview.image = `${slug}.${ext}`;
        mkdirSync(dir(), { recursive: true, mode: 0o750 });
        for (const e of Object.values(IMAGE_TYPES)) rmSync(join(dir(), `${slug}.${e}`), { force: true });
        writeFileSync(join(dir(), preview.image), img.body, { mode: 0o640 });
      }
    }
  } catch (err) {
    preview = { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  mkdirSync(dir(), { recursive: true, mode: 0o750 });
  writeFileSync(join(dir(), `${slug}.json`), JSON.stringify(preview), { mode: 0o640 });
  return preview;
}

// Two Overview tabs opened at once share one fetch. On globalThis: Next loads modules twice.
const inflight: Map<string, Promise<SitePreview>> = ((globalThis as { layerPreviews?: Map<string, Promise<SitePreview>> }).layerPreviews ??= new Map());

/** The preview for the project's live deployment: from disk, or taken now (once per deployment). */
export async function sitePreview(slug: string, deploymentId: number, url: string, own: string[]): Promise<SitePreview> {
  if (!SLUG.test(slug)) throw new Error("bad slug");
  const file = join(dir(), `${slug}.json`);
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as SitePreview;
      const fresh = saved.deploymentId === deploymentId && saved.url === url && (!saved.error || Date.now() - saved.fetchedAt < RETRY_MS);
      if (fresh && (!saved.image || existsSync(join(dir(), saved.image)))) return saved;
    } catch {
      // unreadable: take it again
    }
  }
  const key = `${slug}:${deploymentId}:${url}`;
  let job = inflight.get(key);
  if (!job) {
    job = take(slug, deploymentId, url, own).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

/** The saved image for a project, if there is one. */
export function previewImage(slug: string): { body: Buffer; type: string } | null {
  if (!SLUG.test(slug)) return null;
  for (const [type, ext] of Object.entries(IMAGE_TYPES)) {
    const path = join(dir(), `${slug}.${ext}`);
    if (existsSync(path)) return { body: readFileSync(path), type };
  }
  return null;
}

export function removePreview(slug: string): void {
  if (!SLUG.test(slug)) return;
  for (const name of [`${slug}.json`, ...Object.values(IMAGE_TYPES).map((e) => `${slug}.${e}`)]) rmSync(join(dir(), name), { force: true });
}
