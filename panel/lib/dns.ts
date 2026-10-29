// Checking that a domain really points at this server before it goes live,
// using public resolvers over HTTPS (not the server's own resolver, which may
// cache or differ from what Let's Encrypt and visitors see).

export interface DnsAnswers {
  a: string[];
  aaaa: string[];
  cname: string[];
}

export type DnsVerdict =
  | { status: "ok" }
  | { status: "none" }
  | { status: "wrong_ip"; found: string[] }
  | { status: "cloudflare"; found: string[] }
  | { status: "ipv6_mismatch"; found: string[] }
  | { status: "resolvers_disagree" };

// Cloudflare's published proxy ranges (https://www.cloudflare.com/ips-v4).
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];

const ipToInt = (ip: string) => ip.split(".").reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;

export function isCloudflareIp(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const n = ipToInt(ip);
  return CLOUDFLARE_V4.some((cidr) => {
    const [base, bits] = cidr.split("/");
    const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (n & mask) === (ipToInt(base!) & mask);
  });
}

/**
 * What the answers mean for a domain that should point at serverIp. Every
 * resolver must agree; IPv6 records must not point elsewhere (this server has
 * no IPv6 address configured, and Let's Encrypt prefers IPv6 when it exists).
 */
export function evaluateDns(results: DnsAnswers[], serverIp: string): DnsVerdict {
  const key = (r: DnsAnswers) => [...r.a].sort().join(",") + "|" + [...r.aaaa].sort().join(",");
  if (results.length === 0) return { status: "none" };
  if (new Set(results.map(key)).size > 1) return { status: "resolvers_disagree" };
  const { a, aaaa } = results[0]!;
  if (a.length === 0 && aaaa.length === 0) return { status: "none" };
  if (a.some(isCloudflareIp)) return { status: "cloudflare", found: a };
  if (a.length === 0 || a.some((ip) => ip !== serverIp)) return { status: "wrong_ip", found: [...a, ...aaaa] };
  if (aaaa.length > 0) return { status: "ipv6_mismatch", found: aaaa };
  return { status: "ok" };
}

/** A one-line explanation and fix for each verdict. */
export function explainDns(v: DnsVerdict, host: string, serverIp: string): string {
  switch (v.status) {
    case "ok":
      return `${host} points at this server.`;
    case "none":
      return `${host} has no DNS record yet. Add the record below; changes can take a few minutes to show up.`;
    case "wrong_ip":
      return `${host} points at ${v.found.join(", ")}, not this server (${serverIp}). Update the record.`;
    case "cloudflare":
      return `${host} is proxied by Cloudflare (orange cloud). Set the record to "DNS only", or keep the proxy and set SSL/TLS to "Full (strict)" after the certificate is issued.`;
    case "ipv6_mismatch":
      return `${host} also has an AAAA (IPv6) record (${v.found.join(", ")}) that doesn't point here. Remove it, or Let's Encrypt validation will fail.`;
    case "resolvers_disagree":
      return `Public resolvers don't agree on ${host} yet; a DNS change is still spreading. Try again in a few minutes.`;
  }
}

const RESOLVERS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];

async function query(resolver: string, host: string, type: "A" | "AAAA"): Promise<{ a: string[]; cname: string[] }> {
  const res = await fetch(`${resolver}?name=${encodeURIComponent(host)}&type=${type}`, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${new URL(resolver).hostname} answered HTTP ${res.status}`);
  const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
  const answers = body.Answer ?? [];
  const wanted = type === "A" ? 1 : 28;
  return { a: answers.filter((x) => x.type === wanted).map((x) => x.data), cname: answers.filter((x) => x.type === 5).map((x) => x.data.replace(/\.$/, "")) };
}

/** Looks the domain up at both public resolvers. */
export async function lookupDomain(host: string): Promise<DnsAnswers[]> {
  return Promise.all(
    RESOLVERS.map(async (resolver) => {
      const [v4, v6] = await Promise.all([query(resolver, host, "A"), query(resolver, host, "AAAA")]);
      return { a: v4.a, aaaa: v6.a, cname: [...new Set([...v4.cname, ...v6.cname])] };
    }),
  );
}

export async function checkDomain(host: string, serverIp: string): Promise<{ verdict: DnsVerdict; message: string; answers: DnsAnswers[] }> {
  const answers = await lookupDomain(host);
  const verdict = evaluateDns(answers, serverIp);
  return { verdict, message: explainDns(verdict, host, serverIp), answers };
}

// Second-level labels under country domains that are sold as a whole (example.co.uk, example.com.au).
const COUNTRY_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ltd", "plc", "ne", "or"]);

/**
 * The record to tell the user to create: an A record straight to this
 * server, named relative to the domain they bought (@ for the domain itself,
 * www for www.example.com). Never a CNAME to the free sslip.io address: that
 * would make their domain depend on a service they don't control, and on
 * networks that block it.
 */
export function suggestedRecord(host: string, serverIp: string): { type: "A"; name: string; value: string } {
  const labels = host.split(".");
  const bought = labels.length >= 3 && labels.at(-1)!.length === 2 && COUNTRY_SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return { type: "A", name: labels.slice(0, -bought).join(".") || "@", value: serverIp };
}
