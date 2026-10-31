// DB-IP's "IP to Country Lite" (CC BY 4.0, https://db-ip.com) as geo.bin, the
// table Links looks countries up in. The CSV has one range per line
// (first,last,country) and covers every address in order, so each range is
// kept as its first address and its country; neighbours with the same country
// are merged. IPv6 keeps the first 64 bits of each start, which tell
// countries apart. The build bundles a copy; a monthly cron job writes a
// fresh one to data/geo.bin.
//
// geo.bin, little-endian: a 64-byte header ("LGEO", version 1, the number of
// country codes, IPv4 and IPv6 ranges, and the source's name), the codes (two
// letters each, padded to 8 bytes), then the IPv6 starts (8 bytes each), the
// IPv4 starts (4 bytes each), the IPv6 codes and the IPv4 codes (1 byte each,
// an index into the codes).

export const GEO_MAGIC = "LGEO";
export const HEADER_BYTES = 64;

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d{1,3}$/.test(p) || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** The first 64 bits of an IPv6 address, or null when it isn't one. */
export function ipv6High(ip: string): bigint | null {
  const text = ip.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(text) || (text.match(/::/g) ?? []).length > 1) return null;
  const [head = "", tail] = text.split("::");
  const groups = (s: string) => (s ? s.split(":") : []);
  let left = groups(head);
  let right = tail === undefined ? [] : groups(tail);
  // An IPv4 tail (::ffff:1.2.3.4) is two groups.
  const last = (tail === undefined ? left : right).at(-1);
  if (last?.includes(".")) {
    const v4 = ipv4ToInt(last);
    if (v4 === null) return null;
    const pair = [(v4 >>> 16).toString(16), (v4 & 0xffff).toString(16)];
    if (tail === undefined) left = [...left.slice(0, -1), ...pair];
    else right = [...right.slice(0, -1), ...pair];
  }
  const missing = 8 - left.length - right.length;
  if ((tail === undefined && missing !== 0) || missing < 0) return null;
  const all = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.slice(0, 4).reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** The CSV as geo.bin. Throws when it doesn't look like DB-IP's file. */
export function buildGeo(csv: string, source: string): Buffer {
  const codes: string[] = [];
  const codeIndex = new Map<string, number>();
  const v4: { start: number; code: number }[] = [];
  const v6: { start: bigint; code: number }[] = [];
  for (const line of csv.split("\n")) {
    const [first, , country] = line.trim().split(",");
    if (!first || !country) continue;
    const cc = country.replace(/"/g, "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) throw new Error(`not a country code: ${country}`);
    let code = codeIndex.get(cc);
    if (code === undefined) {
      code = codes.length;
      if (code > 255) throw new Error("more than 256 country codes");
      codes.push(cc);
      codeIndex.set(cc, code);
    }
    const start = first.replace(/"/g, "");
    if (start.includes(":")) {
      const high = ipv6High(start);
      if (high === null) throw new Error(`not an IPv6 address: ${start}`);
      const prev = v6.at(-1);
      if (prev && prev.start === high) prev.code = code;
      else if (!prev || prev.code !== code) v6.push({ start: high, code });
    } else {
      const n = ipv4ToInt(start);
      if (n === null) throw new Error(`not an IPv4 address: ${start}`);
      if (v4.at(-1)?.code !== code) v4.push({ start: n, code });
    }
  }
  if (v4.length < 2 || v6.length < 2) throw new Error("the file has too few ranges to be DB-IP's country list");
  const codesBytes = Math.ceil((codes.length * 2) / 8) * 8;
  const total = HEADER_BYTES + codesBytes + v6.length * 8 + v4.length * 4 + v6.length + v4.length;
  const ab = new ArrayBuffer(total);
  const bytes = new Uint8Array(ab);
  const view = new DataView(ab);
  bytes.set(Buffer.from(GEO_MAGIC, "ascii"), 0);
  view.setUint8(4, 1);
  view.setUint16(6, codes.length, true);
  view.setUint32(8, v4.length, true);
  view.setUint32(12, v6.length, true);
  bytes.set(Buffer.from(source.slice(0, 40), "ascii"), 16);
  bytes.set(Buffer.from(codes.join(""), "ascii"), HEADER_BYTES);
  let off = HEADER_BYTES + codesBytes;
  v6.forEach((r, i) => view.setBigUint64(off + i * 8, r.start, true));
  off += v6.length * 8;
  v4.forEach((r, i) => view.setUint32(off + i * 4, r.start, true));
  off += v4.length * 4;
  v6.forEach((r, i) => view.setUint8(off + i, r.code));
  off += v6.length;
  v4.forEach((r, i) => view.setUint8(off + i, r.code));
  return Buffer.from(ab);
}
