// A click's country, from the visitor's address, looked up in geo.bin
// (geo-build.ts) in memory and forgotten: nothing leaves the server and no
// address is stored.
import type { IncomingMessage } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { GEO_MAGIC, HEADER_BYTES, ipv4ToInt, ipv6High } from "./geo-build.ts";

export class Geo {
  readonly source: string;
  readonly #codes: string[];
  readonly #v4: Uint32Array;
  readonly #v4Codes: Uint8Array;
  readonly #v6: BigUint64Array;
  readonly #v6Codes: Uint8Array;

  constructor(file: Uint8Array) {
    // The 8-byte columns are read in place, so the bytes must start their buffer
    // (a file this size gets a buffer of its own; anything else is copied).
    let ab = file.buffer as ArrayBuffer;
    if (file.byteOffset !== 0 || file.byteLength !== ab.byteLength) {
      ab = new ArrayBuffer(file.byteLength);
      new Uint8Array(ab).set(file);
    }
    const view = new DataView(ab);
    if (Buffer.from(ab, 0, 4).toString("ascii") !== GEO_MAGIC || view.getUint8(4) !== 1) throw new Error("not a geo.bin file");
    const nCodes = view.getUint16(6, true);
    const n4 = view.getUint32(8, true);
    const n6 = view.getUint32(12, true);
    this.source = Buffer.from(ab, 16, 40).toString("ascii").replace(/\0+$/, "");
    const codes = Buffer.from(ab, HEADER_BYTES, nCodes * 2).toString("ascii");
    this.#codes = Array.from({ length: nCodes }, (_, i) => codes.slice(i * 2, i * 2 + 2));
    let off = HEADER_BYTES + Math.ceil((nCodes * 2) / 8) * 8;
    this.#v6 = new BigUint64Array(ab, off, n6);
    off += n6 * 8;
    this.#v4 = new Uint32Array(ab, off, n4);
    off += n4 * 4;
    this.#v6Codes = new Uint8Array(ab, off, n6);
    off += n6;
    this.#v4Codes = new Uint8Array(ab, off, n4);
  }

  /** Two letters (US), or null for private and unknown addresses. */
  country(ip: string): string | null {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
    const v4 = ipv4ToInt(mapped ?? ip);
    const code = v4 !== null ? this.#find(this.#v4, this.#v4Codes, v4) : this.#find(this.#v6, this.#v6Codes, ipv6High(ip));
    const cc = code === null ? null : (this.#codes[code] ?? null);
    return cc === "ZZ" ? null : cc;
  }

  /** The last range starting at or before the address. */
  #find<T extends number | bigint>(starts: ArrayLike<T>, codes: Uint8Array, value: T | null): number | null {
    if (value === null || starts.length === 0 || value < starts[0]!) return null;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= value) lo = mid;
      else hi = mid - 1;
    }
    return codes[lo] ?? null;
  }
}

/** The fresher of the cron job's copy (data/geo.bin) and the one in the release. */
export function loadGeo(paths: string[]): { geo: Geo; path: string } | null {
  const found = paths
    .map((path) => {
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const { path } of found) {
    try {
      return { geo: new Geo(readFileSync(path)), path };
    } catch (err) {
      console.error(`skipping ${path}: ${(err as Error).message}`);
    }
  }
  return null;
}

// Cloudflare's proxies (https://www.cloudflare.com/ips/). Only a request from
// one of these may say who the visitor is (CF-Connecting-IP).
const CLOUDFLARE_V4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"];
const CLOUDFLARE_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

const v4Ranges = CLOUDFLARE_V4.map((cidr) => {
  const [ip = "", bits = "32"] = cidr.split("/");
  const size = 2 ** (32 - Number(bits));
  return [ipv4ToInt(ip)!, size] as const;
});
const v6Ranges = CLOUDFLARE_V6.map((cidr) => {
  const [ip = "", bits = "64"] = cidr.split("/");
  const shift = BigInt(64 - Number(bits));
  return [ipv6High(ip)! >> shift, shift] as const;
});

export function isCloudflare(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return v4Ranges.some(([start, size]) => v4 >= start && v4 < start + size);
  const high = ipv6High(ip);
  return high !== null && v6Ranges.some(([prefix, shift]) => high >> shift === prefix);
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * The visitor's address. Caddy (the only way in from outside) sets
 * X-Forwarded-For to the address it saw; behind Cloudflare's proxy that's
 * Cloudflare's, and the visitor's is in CF-Connecting-IP.
 */
export function clientIp(req: IncomingMessage): string | null {
  const forwarded = first(req.headers["x-forwarded-for"])?.split(",").pop()?.trim();
  const ip = (forwarded || req.socket.remoteAddress || "").replace(/^::ffff:(?=\d+\.)/i, "") || null;
  if (ip && isCloudflare(ip)) return first(req.headers["cf-connecting-ip"])?.trim() || ip;
  return ip;
}
