# Week 3 plan: custom domains, crons, alerts

> Agreed 2026-10-28. Builds on [PLAN-WEEK2.md](PLAN-WEEK2.md); product context in [CLAUDE.md](CLAUDE.md).

**Goal:** a project can be served on the user's own domain (verified before it goes live, with certificate status), run scheduled jobs, and tell the user when something breaks.

## Decisions (2026-10-28)
1. **Crons are systemd timers**, one per job, running as the app user in the app's sandbox with its env, from the live release. Visible with `systemctl list-timers`; they keep running if the panel is down or removed.
2. **Alert channels for v1: Telegram, Discord and a generic webhook.** Email (SMTP) in Week 4, ideally through maillayer-lite.
3. **www default:** adding `example.com` offers `www.example.com` too, redirecting **www → apex**.

## Custom domains
- **Add:** the panel shows the record to create: `A` → the server's IPv4 for apex domains, `CNAME` → the app's free `*.sslip.io` host (or `A`) for subdomains.
- **Verify before going live:** query public DNS over HTTPS (Cloudflare 1.1.1.1 and Google 8.8.8.8). The domain is added to Caddy only when it resolves to this server. It catches: no record yet, a wrong IP, a Cloudflare-proxied record (explain "DNS only" or SSL "Full (strict)"), and a stray `AAAA` record pointing elsewhere (Let's Encrypt prefers IPv6, so validation would fail).
- **Redirect domains:** `www.example.com` → `https://example.com{uri}` (301), rendered by the agent as its own Caddy site block.
- **Certificate status:** a TLS handshake with the domain as SNI, checked against the system trust store. It shows issuer and expiry, or "issuing…". Deploys and domain changes wait until a new domain's certificate works.

## Day by day
| Day | Work | Done when |
|---|---|---|
| **1** | DNS check (DoH, two resolvers, Cloudflare ranges, AAAA), domains table, agent redirects in `proxy.set`, certificate check | Unit tests cover every DNS outcome; redirects render and reload in Caddy |
| **2** | Domains UI (add with DNS instructions, verify, status, primary, remove), deploys wait for new certificates | A real domain goes live on the VPS with a Let's Encrypt certificate; www redirects |
| **3** | Agent: `cron.write` / `cron.delete` / `cron.run` / `cron.history` with timer units in the app sandbox | e2e: a job runs on schedule and on demand, as the app user, with env, history visible |
| **4** | Crons UI | Add, edit, run now, history and logs from the panel |
| **5** | Alerts engine: monitor loop, one alert per incident plus recovery, Telegram, Discord, webhook | Deploy failure, crash loop, disk and certificate alerts fire once and recover |
| **6** | Alerts UI, VPS run-through, docs | All of the above on the real VPS |

## Day 1 result (2026-10-28)
**Done:** DNS check, domains table, redirects, certificate check.
- `panel/lib/dns.ts`: DNS over HTTPS at Cloudflare and Google; `evaluateDns` → ok / none / wrong_ip / cloudflare / ipv6_mismatch / resolvers_disagree, each with an explanation and fix; Cloudflare's published ranges; suggested record (A for apex, CNAME to the free host for subdomains). Checked live: an sslip host is ok, cloudflare.com is flagged as proxied, github.com is a wrong IP, a missing name is none.
- `panel/lib/cert.ts`: TLS handshake through Caddy with the domain as SNI, verified against the trust store → issuer, expiry, days left, or issuing / untrusted / expired / unreachable. Checked live against the VPS and github.com.
- `project_domains` (migration 4 copies existing free hosts in), `servingConfig()` (active hosts and redirects), `applyDomains()` (pushes to Caddy without a deploy); deploys now use it.
- Agent: `proxy.set` takes `redirects` ({from, to}; targets must be the site's own domains; no host twice) → one Caddy block each, `redir https://<to>{uri} permanent`. The blue/green e2e checks it in a real Caddy (path and query kept, foreign targets refused).

**Testing without the user's domain:** any `<name>.<ip-with-dashes>.sslip.io` resolves through public DNS exactly like a custom domain would, so on the VPS `shop.37-27-25-45.sslip.io` (and `www.shop…`) gets a real Let's Encrypt certificate through the full verify flow.

**Needs from the user (Day 2, optional):** a domain or subdomain that can point at the VPS (37.27.25.45).
