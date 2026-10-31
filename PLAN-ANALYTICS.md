# Integrations, part 2: Analytics

> Drafted 2026-10-31, after Links ([PLAN-LINKS.md](PLAN-LINKS.md)), on the same platform: a catalog app, installed from Integrations, sandboxed like any app, managed in the panel. Built from scratch for Self Host Layer: what we learned running Piqo (cookie-free counting, what owners look at), none of its code or design.

**Goal:** Integrations → Analytics → **Install**, then the sidebar's **Analytics** page shows visitors, pages, sources, countries and devices for each site you add, with no cookies and nothing leaving the server. Adding one of your projects takes one click and one line of HTML.

## How it works

```
your site's pages ── <script defer src="https://<analytics domain>/script.js" data-site="example.com">
        │  a pageview on load and on each route change (SPAs), custom events by hand
        ▼
POST https://<analytics domain>/api/event ──▶ Caddy ──▶ Analytics on 127.0.0.1, as user app-analytics
        │  checked against the site's domain, bots dropped, the address looked up and forgotten
        ▼
data/analytics.db (SQLite): events, and visits built as events arrive
        ▲
panel: Analytics page ──(admin token, 127.0.0.1 only)──▶ Analytics' admin API
```

## Decisions (defaults, 2026-10-31; change any of them)
1. **One service, like Links:** `node:http` plus `node:sqlite`, no dependencies, bundled by esbuild. Links and Analytics share their country lookup (DB-IP), User-Agent rules and HTTP helpers in `catalog/lib/`.
2. **In the panel, on the sidebar's Analytics page** (it covers every project, so it isn't only under the integration). Without Analytics installed it offers **Install**. The integration's own project pages (Logs, Domains, Backups, Settings) stay as for Links.
3. **The script:** under 2 KB, no cookies or storage, from Analytics' own domain (its free URL, or one you add on its Domains page). It sends a pageview on load and on each `pushState`/`popstate`, and `window.shl.track("Signup", { plan: "pro" })` sends a custom event. Serving it from each project's own domain (harder for ad blockers to block) comes later.
4. **Sites:** each is a domain (`example.com`, and its subdomains if you choose). Events for an unknown site or from a page on another domain are dropped. One click adds any of your projects' domains, and the panel shows the line to paste into its HTML. Putting it into your apps automatically comes later.
5. **What a pageview keeps:** the time, the path (no query string, except UTM tags kept apart), the referring site, UTM source, medium and campaign, country, device, browser, OS and screen size. A visitor is a hash of address and User-Agent under a salt per site that changes daily, as in Links. No address or cookie is stored.
6. **Visits:** built as events arrive (a visitor's events less than 30 minutes apart are one visit), with entry and exit page, pageviews, duration and bounce. Duration comes from the time between a visit's first and last events, plus pings when the page is hidden.
7. **Stats:** today, 24 hours, 7, 30 or 90 days. Unique visitors, visits, pageviews, bounce rate and visit duration over time. Top pages, entry and exit pages, referring sites, UTM tags, countries, devices, browsers, OSes and custom events. A live count of visitors in the last 5 minutes. Clicking a row filters everything by it (a page, a source, a country).
8. **Data:** events and visits are kept 365 days (a setting), then deleted by a daily cron job. Bots are dropped at the door (User-Agent rules and `navigator.webdriver`), never stored.

## Day by day
| Day | Work | Done when |
|---|---|---|
| **1** | `catalog/lib` shared with Links; the service: database, sites, the script, `/api/event` (CORS, site check, bots), visits as events arrive | Unit tests with recorded events; Links' tests still pass |
| **2** | Stats and live counts, filters, the admin API, retention cron | Tests; 2,000 events a second on the dev machine; under 40 MB idle |
| **3** | Panel: the Analytics page (Install, sites, add a site and its snippet, the dashboard) | Screenshots in light, dark and on phones |
| **4** | Browser tour: install, add a site, a pageview from the script, seen on the dashboard; CI; docs | Tour passes in the VM |
| **5** | Publish to the catalog and a panel release; dogfood on selfhostlayer.com | Real visits counted on the live server |

## Days 1–2 result (2026-10-31)
**Day 1, done when "Unit tests with recorded events; Links' tests still pass": passed. Day 2, done when "Tests; 2,000 events a second on the dev machine; under 40 MB idle": passed.**

- **`catalog/lib`:** Links and Analytics share the country lookup (DB-IP), the User-Agent rules, the HTTP helpers, the migration runner and the build (esbuild bundles, `geo.bin`). Links moved onto it unchanged, with its tests passing.
- **`catalog/analytics`:** a Node service with no dependencies. `server.js` is 38 KB, and the tarball also carries the country table.
  - **`/script.js`:** about 1.6 KB, no cookies or storage. It sends a pageview on load and on `pushState`/`popstate`, a ping when the page is hidden, and custom events from `window.shl.track()`. Nothing is sent from automated browsers, localhost or prerendering. The tests run the real script in a pretend page.
  - **`POST /api/event`:** answers CORS for any site's pages. The event must name a site here and come from a page on its domain (www. always counts, subdomains when chosen). Bots are dropped. Each address and site may send 300 events a minute.
  - **Visits:** built as events arrive, 30 minutes apart being a new one. A visit keeps its entry and exit page, pageviews, events, time (pings included), referring site, UTM tags, country, device, browser, OS and screen. No address is stored; visitors are a hash under a salt that changes daily, as in Links.
  - **Writes:** events and visits are written every second (or 200 events) in one transaction.
  - **Stats:** today, 24 hours, or 7, 30 or 90 days. Visitors, visits, pageviews, bounce rate and visit time, against the period before; series by hour or day; pages, entry and exit pages, referrers, UTM tags, countries, devices, browsers, OSes, screens and custom events. Filters by any of them, and by page. A live count of the last 5 minutes.
  - **Admin API** (127.0.0.1 with the install's token, 404 through Caddy): sites, stats, live, settings.
  - **Cron jobs:** `prune` daily (365 days by default), and `geo` monthly.
- **Speed:** 21,742 events a second on the dev machine (64 connections), none lost; p50 2 ms. Stats over 108,000 events and 62,500 visits take about 0.8 s.
- **Memory:** 21 MB of its own idle on Linux (RSS 67 MB with Node's shared binary). A burst of 62,500 new visitors in 5 seconds grew it to 233 MB on macOS, since open visits stay in memory for 30 minutes. If real traffic ever comes near that, the open visits kept should be capped.
- **Tests:** 9 in `catalog/analytics/test`, and the shared parts' tests in `catalog/lib/test`.
