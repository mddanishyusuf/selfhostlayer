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

## Day 3 result (2026-10-31)
**Done when "Screenshots in light, dark and on phones": done.** The sidebar's **Analytics** page:
- **Not installed:** what Analytics does, and **Install** (from the catalog).
- **No sites yet:** a domain to add, or any of your projects' domains in one click.
- **A site:**
  - its tabs (with 24-hour visitors) and the range: today, 24 hours, 7, 30 or 90 days;
  - totals against the period before (visitors with the live count, visits, pageviews, bounce rate, visit time);
  - a visitors chart (the bar chart Links' stats use, now shared);
  - cards with tabs: pages (top, entry, exit), sources (sites, UTM source, medium, campaign), countries and devices (device, browser, OS, screen), plus custom events. Clicking a row filters the whole page by it, and each filter shows above with a × to remove it.
  - **Setup:** the line to paste (with Copy), subdomains on or off, and Remove (type the domain).
- **The integration's own pages:** a Dashboard item at the top of its sidebar, and its retention setting on its Settings page.
- **Phones:** the range sits in its own row, so nothing runs past the screen.

## Day 4 result (2026-10-31)
**Done when "Tour passes in the VM": passed.** The browser tour's Analytics section (`TOUR_ANALYTICS=1`, in CI):
1. installs Analytics from the Analytics page;
2. adds the panel's own address as a site, and checks the line to paste;
3. loads the script on a panel page, as a person's browser would (`navigator.webdriver` off, a desktop User-Agent), and sends a custom event;
4. finds the pageview (`/settings`) and the event (`Tour`) on the dashboard;
5. uninstalls Analytics, and the page offers Install again.

CI builds Analytics with the other catalog apps, lists it in the test catalog, and checks that nothing is left after the uninstall. `docs/analytics.md` (and the same on the website) explains installing, the dashboard, custom events, what's counted and what isn't, and how long it's kept.

# Part 2: Analytics as its own area in the panel (asked 2026-10-31)

**Goal:** with Analytics installed, opening it collapses the panel's sidebar to icons and shows Analytics' own sidebar for the chosen site, like Piqo:
- a site selector at the top;
- Overview (today's dashboard), Realtime, Pages, Users, Goals, Revenue, Outbound and Settings.

## Decisions
1. **Routes:** `/analytics/<site>/<section>`. `/analytics` opens the first site, or offers Install or a first site. The main sidebar collapses to its 56px icon column there, as on the database viewer; Analytics' sidebar (208px) sits beside it, and phones get both as drawers.
2. **Realtime:** visitors in the last 5 minutes, visits by the minute over the last 30, the pages people are on, and the latest events as they come. It refreshes every 5 seconds.
3. **Pages:** one table, searchable and sortable, with visitors, pageviews, entries, exits, bounce rate and time on page.
4. **Users:** visits, newest first. Each row has country, device, browser, OS, source, entry and exit, pages, time, events and revenue, and opens the visit's journey: its pages, events, outbound clicks and payments, in order. Without cookies a visitor can't be followed from one day to the next, so a row is a visit. Search, and a filter by goal.
5. **Goals:** a page (with `*` wildcards) or a custom event, each with conversions (visitors who reached it), conversion rate and revenue from those visits. Users can be filtered by a goal.
6. **Outbound:** the script counts clicks on links to other sites (event `Outbound link`, with the URL). The page lists the destinations with visitors and clicks.
7. **Revenue attribution (Stripe, Dodo Payments, Polar), as in Piqo but without cookies:**
   - The script holds the visit's id in memory (`window.shl.visit`, or `await window.shl.ready`). The site passes it into its checkout's `metadata` as `shl_visit`.
   - Analytics pulls succeeded payments every 10 minutes (and on **Sync now**) with an API key per provider, best restricted to reading payments:
     - Stripe: completed checkout sessions, and paid invoices for renewals;
     - Polar: paid orders;
     - Dodo: succeeded payments.
   - A payment with `shl_visit` is credited to that visit's source, campaign, entry page and country. A renewal goes to the customer's first payment's visit. Anything else counts as unattributed.
   - Only amounts, currency, time and the provider's customer id are kept; no email or name.
   - Revenue shows on Overview (total, revenue per visitor) and on its own page: by source, campaign, entry page, country, and the latest payments.
8. **Settings, per site:**
   - the domain, subdomains and the line to paste;
   - the revenue providers (key, test or live, last sync and its error);
   - removing the site.
9. **Analytics 0.2.0** carries migration 2 (goals, revenue sources, payments). Installs update to it from Integrations.

## Part 2 result (2026-10-31)

Built as decided above, as **Analytics 0.2.0** and the panel's new Analytics pages.

**The service** (`catalog/analytics`):
- **Migration 2:** goals; revenue sources (each provider's key encrypted with AES-256-GCM under a key made from the admin token, its mode, last sync and error); payments (amount without tax, currency, time, customer id, the visit they're credited to); and each paying customer's first visit.
- **The script** (2.3 KB):
  - pageviews go by `fetch`, whose answer names the visit: `window.shl.visit`, and `window.shl.ready` (null where nothing is sent);
  - clicks on links to other sites are the event `Outbound link`, with the address without its query string;
  - links to `buy.stripe.com` get `client_reference_id`, and links to `checkout.dodopayments.com` get `metadata_shl_visit`, on the way out.
- **Revenue** (`src/revenue.ts`): payments are pulled every 10 minutes (and on Sync now), from 24 hours 20 minutes before the last sync (90 days the first time), with a key checked by one small request:
  - **Stripe:** completed checkouts (paid ones, and free trials' to tie the customer to the visit; adaptive pricing counted in the price's own currency), and paid invoices after a subscription's first.
  - **Polar:** paid orders (net of tax), production or sandbox.
  - **Dodo Payments:** succeeded payments, each new one read once for its tax and the amount credited in the account's currency.
  - A payment's own `shl_visit` (or Stripe's `client_reference_id`) credits it to that visit if it's this site's; otherwise it goes to the customer's first visit. A visit that brought a payment outlives the keep window (its events don't).
- **Reports** (`src/reports.ts`, `src/goals.ts`):
  - the pages table (time on page from the next pageview, or the end of the visit);
  - visits, searched and narrowed to a goal or to paying ones, and each visit's journey;
  - realtime;
  - outbound links;
  - goals, matched with GLOB so `*` is the only wildcard.
- **Tests:** 15, with Stripe, Polar and Dodo answered by a fake `fetch`.
- **Numbers:** 21,536 events a second on the dev machine (21,742 before).

**The panel:**
- `/analytics/<domain>/…`, where the sidebar shrinks to its icons and Analytics' sidebar opens beside it (`components/analytics-nav.tsx`): a site picker (a `Dropdown` from `components/menu.tsx`), then Overview, Realtime, Pages, Users, Goals, Revenue, Outbound and Settings.
- On phones, the picker and the pages are a row of tabs above the page.
- `/analytics` offers Install or the first site, or opens the first site.
- **The tour** installs Analytics 0.2.0, then checks:
  - `window.shl.ready`;
  - the visit on Overview, Realtime, Pages and Outbound (a click kept from leaving the page);
  - its journey on Users;
  - a goal that counts it;
  - Revenue's setup and the site's Settings;
  - nothing left after Uninstall.
- It passes on the VM. CI takes the Analytics tarball of whatever version was built.
