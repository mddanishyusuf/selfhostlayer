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

## Day 2 result (2026-10-28)
**Done when "a real domain goes live on the VPS with a Let's Encrypt certificate; www redirects": passed** with `shop.37-27-25-45.sslip.io` (resolves through public DNS like any custom domain): both it and `www.shop…` got Let's Encrypt certificates, and `https://www.shop…/a/b?c=1` answers 301 → `https://shop…/a/b?c=1`.

- **Domains page** (`/projects/[slug]/domains`): add a domain (+ www redirect, on by default) → DNS checked at once → live, or pending with the explanation and the exact record (with copy) and a Verify button; certificate status per live domain (issuer and days left, issuing, local CA, expired, unreachable), streamed in separately; remove (the free URL stays). Linked from the project page; breadcrumbs.
- **Deploys wait for new certificates** (up to 90s, logged; not fatal, Caddy keeps retrying).
- **Browser tour** (`TOUR_DOMAIN=…`): add a domain + www → both verified and live; add `github.com` → stays pending with "points at …, not this server" and the record; remove it. Passes in the VM.
- **Bug found by the screenshots:** `SubmitButton` always added `w-full`, which beat a caller's `w-auto` and squashed the input next to inline buttons. It now applies `w-full` only when no width is given.

## Day 3 result (2026-10-29)
**Done when "a job runs on schedule and on demand, as the app user, with env, history visible": passed** in the VM (`installer/test/cron-e2e.sh`, also in CI).

- **Units:** `app-<slug>-cron-<name>.timer` (OnCalendar, `Persistent=true` so a run missed while the server was down happens after boot) + `.service` (oneshot, `TimeoutStartSec`). The service runs as the app user with the app's env file, pinned Node and **the same sandbox lines as the app unit** (now one shared `sandboxLines()`), from `/srv/apps/<slug>/current`, which `proxy.set` now points at whatever release is live.
- **Actions:** `cron.write` (schedule checked by `systemd-analyze calendar`, which also gives the next run), `cron.delete`, `cron.run` (non-blocking), `cron.list` (schedule, next run, last result), `cron.history` (runs from the journal). `app.delete` removes an app's cron units.
- **Schedules:** the panel converts cron expressions (`*/15 * * * *`, ranges, lists, steps, names, `@daily`…) to OnCalendar (`panel/lib/cron.ts`, 26 tests); all 14 converted forms are accepted by real `systemd-analyze`. Setting both day-of-month and day-of-week is refused (cron ORs them, systemd ANDs).
- **Finding:** a job that exits quickly can lose its `_SYSTEMD_INVOCATION_ID` in the journal, so history groups runs by systemd's own start/end messages and places unmarked output lines by time.
- **Installer:** apt failing on "not valid yet" (a wrong server clock, e.g. a VM resumed after the host slept) now says so and points at `timedatectl`.

## Day 4 result (2026-10-29)
**Done when "add, edit, run now, history and logs from the panel": passed** in the VM through the browser tour (save a job, its timer is scheduled, Run now → "Succeeded" with the app's env var in the output).

- **Crons page** (`/projects/[slug]/crons`): jobs with live state from systemd (next run, running, last result), Run now, Delete; add/update form with schedule presets, a plain-language description ("every 30 minutes") and validation (`validateCron`: name, cron expression → OnCalendar, command starting with node/npm/npx).
- **Runs page** (`/projects/[slug]/crons/[name]`): history with status, exit code, UTC start time, duration and output (newest open).
- **`project_crons`** keeps jobs as written; every deploy rewrites them (`syncCrons`), so they follow the project's Node version, folder and memory limit.
- **Bug the screenshot caught:** durations showed "-0.0s". For `Type=oneshot` systemd logs "Starting…" first and "Finished" only after the job exits, and the parser took "Finished" as the start. Runs now start at the earliest of the two (test with the real journal order).

## Day 5–6 result (2026-10-29)
**Done when "alerts fire once and recover": passed** in the VM through the browser tour (webhook channel saved and its signed test arrives; a failed cron run sends exactly one "Cron job failed" message, the bell shows it, the next successful run sends exactly one recovery). Deployed to the VPS: monitor running, no incidents, the user's app untouched.

- **Incidents** (`alert_incidents`, one open row per key): `deploy:<id>`, `crash:<slug>`, `disk`, `cert:<host>`, `cron:<slug>:<name>`. One message when opened, one when resolved, nothing in between. Delivery errors are kept on the incident, not thrown.
- **Rules** (`lib/alerts/rules.ts`, pure and tested): disk alerts at 80% and recovers below 75%; crash = systemd gave up or 3+ restarts since the last check; certificates = expired, unreachable, under 14 days, or issuing for over 15 minutes (a local CA is ignored); cron = the last run failed.
- **Monitor** runs inside the panel (`instrumentation.ts`): every 60s, certificates every 10 minutes. State lives on `globalThis` because Next loads modules twice.
- **Channels:** Telegram (bot token + chat ID), Discord (webhook, mentions disabled), webhook (JSON, `X-Layer-Signature: sha256=<HMAC>` when a secret is set, https only). Encrypted at rest. Saving a channel sends a test to it.
- **UI:** Settings → Alerts (open incidents, channels with Send test, recently resolved) and a bell in the top bar with a red dot when anything is open.
- **Bugs found on the way:**
  - "Run now" failures never alerted: a manual start doesn't update the timer's `LastTriggerUSec`. `cron.list` now reports the service's `ExecMainStartTimestamp`.
  - After a server action redirects, Next fetches the target page from `http://localhost:3000`, but the panel listens on a unix socket. On a real box that request would carry the admin's cookies to any app on port 3000. `server.mjs` now pins that origin to `layer-panel.invalid` and serves it over the panel socket.
  - The secondary buttons (Send test, Cancel deploy) had invisible labels: `SubmitButton` takes a `variant` now.
- **Test helper:** `installer/test/alert-receiver.sh` (VM only) runs a webhook receiver at `https://hook.internal` and makes the panel trust Caddy's local CA; `--remove` undoes it.

**Needs from the user (optional):** a Telegram bot or Discord webhook. Add it under Settings → Alerts on the VPS panel and press Send test.

**Needs from the user (optional):** a domain or subdomain that can point at the VPS (37.27.25.45).
