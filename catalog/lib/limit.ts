// Rate limits for the catalog apps' public endpoints: counters in fixed
// windows, keyed by what's being limited (an address and a link, a site…).
// IPv6 addresses count by their /64: a server or a home gets a whole block,
// so a limit per single address is no limit at all. When the map fills, the
// expired counters go first, then the oldest; it's never cleared all at once
// (which would hand every attacker a fresh start).

/** The address a limit counts: IPv4 as it is, IPv6 by its /64. */
export function limitKey(ip: string | null | undefined): string {
  if (!ip) return "?";
  if (!ip.includes(":")) return ip;
  const head = ip.split("::")[0]!.split(":");
  const tail = ip.includes("::") ? ip.split("::")[1]!.split(":").filter(Boolean) : [];
  // The first four groups, with :: filled in.
  const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail].slice(0, 4);
  return `${groups.map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export class Limiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #cap: number;
  #hits = new Map<string, { n: number; until: number }>();

  /** max hits per window for each key; at most cap keys remembered. */
  constructor(max: number, windowMs: number, cap = 50_000) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#cap = cap;
  }

  /** Counts a hit; true when the key is over its limit (the hit is counted all the same). */
  hit(key: string, now = Date.now()): boolean {
    const h = this.#hits.get(key);
    if (h && h.until > now) return ++h.n > this.#max;
    if (h) this.#hits.delete(key);
    if (this.#hits.size >= this.#cap) this.#evict(now);
    this.#hits.set(key, { n: 1, until: now + this.#windowMs });
    return 1 > this.#max;
  }

  /** Whether the key is over its limit, without counting a hit. */
  over(key: string, now = Date.now()): boolean {
    const h = this.#hits.get(key);
    return !!h && h.until > now && h.n >= this.#max;
  }

  get size(): number {
    return this.#hits.size;
  }

  #evict(now: number): void {
    for (const [k, h] of this.#hits) if (h.until <= now) this.#hits.delete(k);
    // Still full: the oldest go (a map keeps its keys in the order they came).
    for (const k of this.#hits.keys()) {
      if (this.#hits.size < this.#cap * 0.9) break;
      this.#hits.delete(k);
    }
  }
}
