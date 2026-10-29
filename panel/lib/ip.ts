// IP addresses and CIDR ranges, for the panel's allowlist (Settings → Access).
import { isIP } from "node:net";

/** Tailscale's address ranges (its CGNAT block and ULA prefix). */
export const TAILSCALE_RANGES = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"];

function toBits(input: string): { value: bigint; bits: number } | null {
  const ip = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(input)?.[1] ?? input;
  if (isIP(ip) === 4) return { value: ip.split(".").reduce((n, part) => (n << 8n) + BigInt(Number(part)), 0n), bits: 32 };
  if (isIP(ip) !== 6) return null;
  // An IPv4 tail (64:ff9b::1.2.3.4) becomes two groups.
  const text = ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_m, a, b, c, d) => `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`);
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return { value: groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g || "0", 16)), 0n), bits: 128 };
}

/** "203.0.113.7" or "203.0.113.0/24" (IPv6 too). */
export function validRange(range: string): boolean {
  const [ip = "", bits, extra] = range.split("/");
  const family = isIP(ip);
  return family !== 0 && extra === undefined && (bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128)));
}

export function inRange(ip: string, range: string): boolean {
  if (!validRange(range)) return false;
  const [base = "", len] = range.split("/");
  const a = toBits(ip);
  const b = toBits(base);
  if (!a || !b || a.bits !== b.bits) return false;
  const shift = BigInt(a.bits - (len === undefined ? a.bits : Number(len)));
  return a.value >> shift === b.value >> shift;
}

export const inRanges = (ip: string, ranges: string[]) => ranges.some((r) => inRange(ip, r));
