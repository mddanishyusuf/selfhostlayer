// Picks an exact Node version for a project from what it asks for
// (.nvmrc, .node-version or engines.node) and Node's release index
// (https://nodejs.org/dist/index.json). Prefers LTS releases.

export interface NodeRelease {
  version: string; // "24.13.1" (no leading v)
  lts: boolean;
}

type Version = [number, number, number];
type Comparator = (v: Version) => boolean;

const parse = (s: string): Version | null => {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(s.trim());
  if (!m) return null;
  const n = (part: string | undefined) => (part === undefined || part === "x" || part === "*" ? NaN : Number(part));
  return [Number(m[1]), n(m[2]), n(m[3])];
};
const cmp = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const filled = (v: Version, pad: number): Version => [v[0], Number.isNaN(v[1]) ? pad : v[1], Number.isNaN(v[2]) ? pad : v[2]];

/** One comparator like ">=20.3", "^22", "~22.1", "22.x" or "22.11.0". */
function comparator(token: string): Comparator | null {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token.trim());
  if (!m) return null;
  const op = m[1] ?? "";
  const v = parse(m[2]!);
  if (!v) return null;
  const lo = filled(v, 0);
  switch (op) {
    case ">=": return (x) => cmp(x, lo) >= 0;
    case ">": return Number.isNaN(v[1]) ? (x) => x[0] > v[0] : (x) => cmp(x, lo) > 0;
    case "<=": return Number.isNaN(v[1]) ? (x) => x[0] <= v[0] : (x) => cmp(x, filled(v, Infinity)) <= 0;
    case "<": return (x) => cmp(x, lo) < 0;
    case "^": return (x) => x[0] === v[0] && cmp(x, lo) >= 0;
    case "~": return Number.isNaN(v[1]) ? (x) => x[0] === v[0] : (x) => x[0] === v[0] && x[1] === v[1] && cmp(x, lo) >= 0;
    default:
      // "22", "22.x", "22.11" or exact "22.11.0".
      return (x) => x[0] === v[0] && (Number.isNaN(v[1]) || x[1] === v[1]) && (Number.isNaN(v[2]) || x[2] === v[2]);
  }
}

/** Parses an npm-style range ("||" alternatives of space-separated comparators). null if unreadable. */
export function parseRange(range: string): ((version: string) => boolean) | null {
  const text = range.trim().replace(/^v(?=\d)/, "");
  if (["", "*", "node", "latest", "current", "lts/*", "lts"].includes(text) || text.startsWith("lts/")) return () => true;
  const alternatives = text.split("||").map((alt) =>
    alt
      .trim()
      .replace(/\s*-\s*/, " - ")
      .split(/\s+/)
      .filter(Boolean),
  );
  const sets: Comparator[][] = [];
  for (const tokens of alternatives) {
    // "18 - 22" hyphen ranges.
    if (tokens.length === 3 && tokens[1] === "-") {
      const a = comparator(`>=${tokens[0]}`);
      const b = comparator(`<=${tokens[2]}`);
      if (!a || !b) return null;
      sets.push([a, b]);
      continue;
    }
    // ">= 20" written with a space.
    const joined: string[] = [];
    for (const t of tokens) {
      if (/^(>=|<=|>|<|=|\^|~)$/.test(t)) joined.push(t);
      else if (joined.length && /^(>=|<=|>|<|=|\^|~)$/.test(joined.at(-1)!)) joined[joined.length - 1] += t;
      else joined.push(t);
    }
    const comps = joined.map(comparator);
    if (comps.some((c) => c === null)) return null;
    sets.push(comps as Comparator[]);
  }
  return (version) => {
    const v = parse(version);
    return v !== null && sets.some((set) => set.every((c) => c(v)));
  };
}

/**
 * The best release for a range: the newest LTS that matches, else the newest
 * release that matches. null when nothing matches (or the range is unreadable).
 */
export function resolveNodeVersion(range: string, releases: NodeRelease[]): string | null {
  const matches = parseRange(range);
  if (!matches) return null;
  const candidates = releases.filter((r) => matches(r.version)).sort((a, b) => cmp(parse(b.version)!, parse(a.version)!));
  return (candidates.find((r) => r.lts) ?? candidates[0])?.version ?? null;
}

/** Releases from nodejs.org/dist/index.json entries. */
export function releasesFromIndex(index: { version: string; lts: string | false }[]): NodeRelease[] {
  return index.map((e) => ({ version: e.version.replace(/^v/, ""), lts: e.lts !== false }));
}
