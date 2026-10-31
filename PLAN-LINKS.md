# Integrations, part 1: the platform, and Links (a link shortener)

> Drafted 2026-10-31. The first marketplace app, built from scratch for Self Host Layer. We use what we learned running Piqo and maillayer (cookie-free counting, custom domains through Caddy, what people actually click), but none of their code or design. Product context in [CLAUDE.md](CLAUDE.md).

**Goal:** Integrations → Links → **Install** puts a link shortener on the box in under a minute: short links on your own domain (`go.example.com/launch` → anywhere), click stats, QR codes and an API, all managed from the panel. Building it also builds what every later integration reuses: the app manifest, the catalog, and install, update and uninstall.

## How an integration runs

**An integration is a project whose code comes from our catalog instead of GitHub.** Everything a project already has applies unchanged: its own Linux user and sandboxed systemd unit, blue/green restarts, domains and certificates, env vars, backups of its data folder (SQLite checked), logs, metrics, cron jobs and alerts. Nothing new runs as root, and the panel stays small: a compromised Links can't reach the panel or the other apps.

```
get.selfhostlayer.com/catalog.json        the catalog: apps, versions, sha256 of each tarball
        │
        ▼
panel: Integrations page ── Install ──▶ agent: download from the feed's host only, check sha256,
                                        unpack to /srv/apps/links/releases/<version> (no build step)
        │
        ▼
the deploy pipeline as today: env.write → unit.write → release.point → unit.start (health) → proxy.set
        │
        ▼
https://go.example.com/launch ──▶ Caddy ──▶ Links on 127.0.0.1, as user app-links ──▶ 302 to the target
panel's Links pages ──(admin token, 127.0.0.1 only)──▶ Links' admin API
```

## Decisions (agreed 2026-10-31)
1. **`source: catalog` on projects.** The deploy pipeline only changes in two places: "fetch" downloads the app from the catalog instead of a GitHub tarball, and "build" is skipped because catalog apps ship built. Integrations are listed on the Integrations page, not on Projects, but keep the project pages (Domains, Logs, Backups, Environment, Settings) under their own routes.
2. **First-party apps live in this repo**, in `catalog/links/`, versioned on their own (Links 0.1.0 is not panel 0.1.5). `node scripts/build-catalog.ts links` builds `links-<version>.tar.gz`. `scripts/publish-catalog.sh links` uploads it to `get.selfhostlayer.com/catalog/` and adds it to `catalog.json`, the same way `releases.json` works today. The agent downloads only from the configured feed's host and checks the sha256, reusing the update code (`agent/src/actions/update.ts`).
3. **The manifest: authors write `layer.yaml`, and the box only reads JSON.** It's the one place an app says what it needs; Links is its first user (format below). The catalog build checks the YAML and turns it into `layer.json` inside the tarball and into the app's entry in `catalog.json`, so the agent needs no YAML parser. The agent checks the JSON again with a validator in `packages/protocol`. `catalog.json` also carries what the Integrations page shows: name, summary, versions, sha256 and the minimum panel version.
4. **Links is a small Node service with no framework:** `node:http` plus `node:sqlite` (built into Node 24, as the panel uses it). There are no native modules, so nothing compiles on the box. It's written in TypeScript and compiled before release. Targets are **under 40 MB of memory idle** and a redirect answered in **under 5 ms** on the box. Next.js would cost about 100 MB for what is mostly a redirect.
5. **Managed inside the panel, not as a separate admin site.** You get one login (the panel's, with 2FA) and one design (the AgentOS look). The panel calls Links' admin API on `127.0.0.1` at the live color's port, with a token made at install. The token is encrypted in the panel's database and given to Links as an env var. Links' public side only redirects, plus an optional public API with tokens you create. A team-facing admin with single sign-on can come later, with the other apps.
6. **A domain from the start.** Links installs on a free URL (`links.<ip>.sslip.io`), so it works at once. You add your short domain (`go.example.com`, or a short domain of its own) on its Domains page, with the same DNS check and certificate as projects. The bare domain redirects to a URL you choose (your site) instead of showing an empty page.
7. **Redirects:**
   - **Status:** 302 by default, so clicks keep counting and browsers don't cache the redirect. Each link can use 301, 307 or 308 instead.
   - **Query strings:** the incoming query string is passed on to the target (`?ref=x` added to it), unless the link turns that off.
   - **Slugs** match without regard to case. `Launch` and `launch` are the same link, so nobody loses a click to a capital letter.
   - **Missing links:** an unknown slug goes to your fallback URL or a plain 404 page. A disabled or expired link gets a 410 page.
8. **Click stats without tracking people.** Each click keeps:
   - the time, the referrer's host, and the device, browser and OS read from the User-Agent;
   - the country (below);
   - whether it came from a bot.

   **Countries come from a free database shipped with Links:** DB-IP's "IP to Country Lite" (CC BY 4.0, a few MB, updated monthly). This works whether or not the domain goes through Cloudflare.
   - The visitor's IP is looked up in memory and forgotten. The lookup needs no network.
   - A monthly cron job fetches the newest database, with the copy shipped in the release as the fallback.
   - Behind Cloudflare, the real visitor IP comes from `CF-Connecting-IP`, trusted only when the request comes from Cloudflare's address ranges. Otherwise Links uses the address Caddy saw.
   - The stats page credits "Country data by DB-IP".

   No IP address or cookie is stored. Unique visitors are counted with a hash that has a new salt each day, and the old salt is thrown away. Raw clicks older than 90 days (a setting) are rolled up into daily counts.
9. **Writes stay off the redirect path.** Slugs are kept in memory: loaded at start and updated when you change a link. Clicks are written in batches, every second or every 100 clicks, in one transaction, with SQLite in WAL mode. A crash can lose at most a second of clicks, never a link.
10. **Safety:**
    - **Targets:** only http and https. No links to the panel's own address, to localhost or to private addresses.
    - **Slugs:** checked against a pattern, with reserved words (`api`, `_admin`, `healthz`, `robots.txt`, `favicon.ico`) refused.
    - **Admin API:** listens on 127.0.0.1 only and needs the token.
    - **Public API:** needs a token you create. Tokens are shown once, stored hashed, and rate-limited.
    - **Password-protected links** show a small form. The password is stored as an scrypt hash, and a correct one sets a signed cookie for that link only.
11. **Updates and data.** When the catalog has a newer Links, the panel shows **Update**. It deploys blue/green, so there's no downtime. Links migrates its own database at start, from numbered migrations, after the agent's backup snapshot. **Uninstall** (typed confirmation, like deleting a project) stops it and removes its user, unit and domains. Its data stays in the last backup.

## The manifest (first version)
```yaml
id: links
name: Links
version: 0.1.0
summary: Short links on your own domain, with click stats and QR codes.
runtime:
  kind: node
  node: "24"
  start: ["node", "server.js"]            # node, npm or npx first: they run on the app's own Node
  health: /healthz
  writable: []                           # folders in the release it writes to; DATA_DIR is always writable
memory: { default: 128, min: 64 }        # MB, as each project's limit (at least 64)
env:
  LINKS_ADMIN_TOKEN: { generate: secret }  # made once at install, kept across updates
  LINKS_FALLBACK_URL: { setting: fallbackUrl, default: "" }
services: [sqlite]                       # data/links.db; PORT and DATA_DIR come from the platform
cron:
  - name: rollup
    schedule: "30 3 * * *"               # cron, as on a project's Cron jobs page
    command: node cron.js rollup         # plain words, node, npm or npx first
backup: [data]
```

## Links v1: what it does
- **Create a link:**
  - the target URL;
  - a custom slug, or a random 7-character one;
  - a title and tags;
  - an expiry date, a password and a redirect type;
  - whether to pass the query string on.
- **The list:**
  - search, filter by tag, and sort by clicks or date;
  - copy the short URL, or show and download its QR code (SVG or PNG);
  - edit, disable or delete.
- **Stats:** clicks over 24 hours, 7 days or 30 days, the top links, referrers, countries, devices, browsers and OSes, and a page for each link. Bots are left out unless you ask for them.
- **The API:** `GET`, `POST`, `PATCH` and `DELETE` on `/api/v1/links` with a bearer token, documented in the panel.
- **CSV import and export**, so you can move links in from another shortener.
- **Settings:**
  - where the bare domain and unknown slugs go;
  - the default redirect type;
  - how long raw clicks are kept;
  - the API tokens.

**Later (v2):** several domains on one install, a link-in-bio page, a UTM builder, targets that differ by country or device, webhooks on clicks, public stats pages, and team members.

## Data (SQLite, `data/links.db`)
| Table | What's in it |
|---|---|
| `links` | id, slug (unique, lowercase), target, title, tags, redirect (302/301/307/308), pass_query, password_hash, expires_at, disabled, created_at, updated_at |
| `clicks` | link_id, at, referrer_host, country, device, browser, os, bot, visitor_hash (daily salt) |
| `clicks_daily` | link_id, day, clicks, visitors, with breakdowns as JSON (referrers, countries, devices) |
| `tokens` | id, name, token_hash, created_at, last_used_at |
| `settings` | key, value (fallback URL, default redirect, how long to keep clicks) |
| `migrations` | id, applied_at |

## Where the code goes
- **`catalog/links/`**, the service:
  - `src/server.ts`: routing and the public side;
  - `src/redirect.ts`: the slug cache and the redirect;
  - `src/clicks.ts`: batching, the User-Agent read and bot checks;
  - `src/admin.ts`: the panel's API;
  - `src/api.ts`: the public API;
  - `src/db.ts` with `migrations/`;
  - `src/qr.ts`;
  - `cron.ts`;
  - `layer.yaml`;
  - unit tests in `test/` (vitest, as the rest of the repo).

  New dependencies must be MIT-style licensed and small: a QR encoder, and a bot list such as `isbot`.
- **Agent:** `source.fetch` learns a catalog mode, or a new `catalog.fetch` action, built on the update code: same host only, sha256 checked, unpacked as the app's user. The manifest is checked by a validator in `packages/protocol`.
- **Panel:**
  - `lib/catalog.ts`: reads `catalog.json` through the agent and caches it like the update check.
  - The project source and the pipeline's skipped build.
  - `app/(app)/integrations/`: the catalog with Install and the installed apps.
  - `app/(app)/integrations/links/`: Links, Stats and Settings.
- **Scripts:** `scripts/build-catalog.ts`, and `scripts/publish-catalog.sh` beside `publish-release.sh`.
- **Docs:** `docs/integrations.md` (how installing works, what runs where) and `docs/links.md`, plus the same on the website.

## Day by day
| Day | Work | Done when |
|---|---|---|
| **1** | Manifest format and validator; `catalog.json`; the build script; the agent's catalog download (host check, sha256, unpack) | VM: a test app downloads and unpacks; a wrong sha256 or another host is refused and nothing is written |
| **2** | Publishing the catalog (get.selfhostlayer.com serves `catalog.json` and the tarballs; the publish script's catalog mode); projects with `source: catalog`: Install from the Integrations page through the existing pipeline, with the hello app; Uninstall | VM: Install puts the hello app on its free URL with HTTPS; Uninstall removes its unit, user and domain |
| **3** | Links core: database and migrations, the slug cache, redirects, batched clicks, the admin API, `/healthz` | Unit tests pass; under 40 MB idle; 10,000 redirects a second on the dev machine |
| **4** | Stats: User-Agent read, referrers, countries from the bundled DB-IP database (and Cloudflare's real visitor IP), bots, daily rollups, the cron jobs | Tests with recorded User-Agents, referrers and addresses |
| **5** | Panel: the links list, create and edit, copy, QR code | Browser tour: create a link in the panel, open it, see the click counted |
| **6** | Panel: stats pages; settings; API tokens and the public API; CSV import and export | API e2e: create, list, edit and delete links with a token; a revoked token is refused |
| **7** | Update to a new Links version (with a migration), backup and restore of `links.db`, uninstall; docs; e2e in CI | VM e2e: install → make links → back up → update to 0.1.1 → restore → uninstall, no link lost |
| **8** | Dogfood on the live server with a real short domain; measure memory and speed there | Real links served from the box; numbers in the result below |

## Agreed 2026-10-31
1. **Tools live in the panel:** no separate site for any integration (decision 5).
2. **Slugs ignore case** (decision 7).
3. **Countries for everyone:** from the bundled DB-IP database, not only behind Cloudflare (decision 8).
4. **Dogfood domain:** `go.selfhostlayer.com` (Day 8; Days 2–7 use the free URL).
5. **Every tool is included in the Self Host Layer license**, never sold on its own (CLAUDE.md, Business model).
6. **The name in the catalog:** "Links" for now.

## Day 1 result (2026-10-31)
**Done when "a test app downloads and unpacks; a wrong sha256 or another host is refused and nothing is written": passed.** `installer/test/catalog-e2e.sh` (10 checks) passes in the VM and runs in CI. `agent/test/catalog.test.ts` adds 8 unit tests.

- **The manifest** (`packages/protocol/src/manifest.ts`): `parseManifest` checks every field against an allowlist, as the other validators do:
  - the id, version, Node version (a major like `24`, or exact);
  - start arguments: plain words, no spaces or shell characters;
  - health path; writable and backup paths, relative only;
  - memory between 64 and 4096 MB (64 since Day 2: a unit's limit is at least 64);
  - env (`generate: secret`, `setting` with a default, or a fixed `value`; no line breaks; names the platform sets, like `PORT` and `DATA_DIR`, refused);
  - services (`sqlite` for now); cron jobs with unique names.
- **The catalog** (`agent/src/actions/catalog.ts`):
  - It lives at `catalogUrl` in `/etc/layer/config.json`, or `catalog.json` beside the update feed.
  - `catalog.list` gives the panel each app's versions and manifests, but not where the tarballs are.
  - Every tarball must be on the catalog's own address, and each manifest must name its app and version. One bad entry makes the whole catalog unreadable: it's ours, so a mistake should stop installs, not slip through.
- **`catalog.fetch`** (in `build.ts`, beside the GitHub fetch, under the same rule that root never touches files in an app's folder):
  - Root downloads into `/var/lib/layer-agent/catalog` (root only) and checks the sha256 before anything is unpacked.
  - tar then unpacks it from stdin as the app's user, offline, in a sandbox, and the download is deleted.
  - The release is named by the first 40 characters of the sha256, so deployments, `release.point`, rollback and pruning treat it like a GitHub commit.
  - A wrong checksum or another host is refused before anything is written. A read error, when the unpack job ends early, can't crash the agent (found by the unit tests).
- **Building:** `node scripts/build-catalog.ts <app>`:
  - checks `catalog/<app>/layer.yaml` (with the `yaml` package, at build time only; the box reads JSON);
  - requires `package.json` to carry the same version;
  - runs `npm run build`, which fills `dist/`;
  - packs `dist/` with `layer.json` under `<id>-<version>/`;
  - prints the sha256 and the manifest for `catalog.json`.
- **The test app** `catalog/hello/`: a Node server that greets and counts visits in SQLite, a `tidy` cron job, and a `greeting` setting. Day 2 installs it for real.
- **Moved to Day 2:** publishing to get.selfhostlayer.com (routes in the website for `catalog.json` and `/catalog/…`, and a catalog mode in the publish script). Day 2's install is the first thing that needs the real catalog.


## Day 2 result (2026-10-31)
**Done when "VM: Install puts the hello app on its free URL with HTTPS; Uninstall removes its unit, user and domain": passed.** The browser tour has an Integrations section (`TOUR_INTEGRATIONS=1`, in CI). It installs Hello from the Integrations page, opens `https://hello.internal` (Caddy's local CA on test boxes), sees it listed as installed and running, and uninstalls it. CI then checks that its user, unit, Caddy site and folder are gone.

- **An integration is a project with `source: catalog`.** A migration adds `source` and `catalog_app` to projects, and `version` and `manifest` to deployments. A deployment names its version, keeps that version's manifest, and uses the release name (from the tarball's checksum) as its sha. Redeploys, rollbacks, restarts for new env vars and the deployment pages work unchanged.
- **The pipeline** applies the version's manifest before each deploy of an integration (`applyManifest`, `panel/lib/catalog.ts`):
  - the start command, health check and writable folders;
  - Node: the server's default when it's the major the manifest asks for, else the newest LTS of that major;
  - memory: the owner's limit, raised to the manifest's minimum when it's lower;
  - env: secrets made once and kept, settings added with their defaults (the owner's values stay), fixed values set;
  - cron jobs as the manifest lists them.

  Then it runs `catalog.fetch` instead of the GitHub fetch, with no install or build step.
- **`catalog.fetch`:**
  - A redeploy names its release, and a release still on the server is used without asking the catalog, so redeploys work while get.selfhostlayer.com is down.
  - A version needing a newer Self Host Layer (`minPanel`) is refused; `catalog.list` says which versions this server can install. Dev and test builds (not semver) can install anything.
- **The manifest, tightened:**
  - The start command and cron commands begin with node, npm or npx, in plain words.
  - Memory is at least 64 MB, a unit's floor.
  - Cron schedules are cron expressions, as on the Cron jobs page; the build script checks them with the panel's parser.
- **The Integrations page:**
  - **Installed:** version, status, Open and Manage.
  - **Catalog:** Install, or Manage once installed, or "Needs <version> or newer".
  - **Coming soon:** Links first.

  The old list's "by Piqo / maillayer" column is gone: every tool is built fresh.
- **An integration's pages** are a project's, with "← Integrations" at the top of the sidebar; Projects doesn't list or count them.
  - **Overview:** the version and "from the catalog" instead of the repo and branch.
  - **Settings:** the memory limit (from the manifest's minimum) and **Uninstall** (type the name, as for Delete; `data/` is archived unless you say otherwise).
- **Publishing:** the website serves `get.selfhostlayer.com/catalog.json` and `/catalog/<app>/<version>/<app>-<version>.tar.gz` from the shl project's data folder (`DATA_DIR/catalog`). `scripts/publish-catalog.sh <app> [--notes "…"] [--min-panel <version>]`:
  1. builds the app from a pushed commit;
  2. puts the version on top of the app's list (`scripts/catalog-feed.ts`, keeping the newest 10);
  3. checks the new catalog with the agent's own `parseCatalog`, since a catalog the servers can't read would stop every install;
  4. uploads the tarball first and the catalog last;
  5. checks the live URL.
- **Tests:**
  - 5 panel unit tests (`panel/lib/catalog.test.ts`) and 5 more agent tests;
  - `installer/test/release-feed.sh catalog <tarball>` serves a test catalog beside the test feed, for the tour.
- **Published:** hello 0.1.0 is in the live catalog (`https://get.selfhostlayer.com/catalog.json`, `minPanel` 0.1.6, sha256 `7159d969…`), published with `scripts/publish-catalog.sh`. The dev VM, pointed at the live catalog, listed it and fetched it into a scratch app: checksum matched, files owned by the app's user. It's a test app: take it out of `catalog.json` on the server when Links is published, or before releasing a panel with Integrations, if it shouldn't show there.

## Days 3–4 result (2026-10-31)
**Day 3, done when "Unit tests pass; under 40 MB idle; 10,000 redirects a second on the dev machine": passed. Day 4, done when "Tests with recorded User-Agents, referrers and addresses": passed.** The service is `catalog/links/`, with no dependencies: esbuild bundles it into `server.js` and `cron.js` (51 KB and 12 KB), and the tarball is 1.4 MB with the country table.

- **Speed:**
  - 34,810 redirects a second on the dev machine (64 connections, the load generator on the same machine), p50 1.6 ms, p99 5.5 ms;
  - 24,642 a second on the 2-vCPU test VM, p50 0.8 ms; a single redirect 0.4–4 ms.
  - No errors, and every click was counted.
- **Memory:** a fresh Links on Linux, idle with the country table loaded, holds 26 MB of its own (RssAnon). Its RSS is 72 MB; the rest is Node's binary mapped from disk, shared by every app on the same Node.
- **Redirects:**
  - 302 by default, 301/307/308 per link (those two cached a day by browsers, so a changed target still takes over);
  - the query string passed on (the visitor's values win); slugs in any case;
  - unknown slugs answer 404 or go to the `missing` setting; turned-off or expired links answer 410; the bare domain goes to `home`;
  - `/favicon.ico` answers 204 and isn't a click (the cause of Hello's double count); HEAD isn't a click either.
- **Password links:** scrypt hashes; a correct password sets a signed cookie for that link only, which stops working when the password changes; 10 tries per address and link every 10 minutes.
- **Clicks:**
  - queued and written every second or every 100, in one transaction; each link's count is kept in memory;
  - visitors are a hash of address and User-Agent under a salt that changes daily; no address or cookie is stored;
  - device, browser, OS and bots (crawlers, chat apps' link previews, monitors, HTTP libraries) come from Links' own short User-Agent rules.
- **Countries:** DB-IP's IP to Country Lite (CC BY 4.0), turned at build time into a 4.8 MB table (range starts and codes) searched in memory. Behind Cloudflare, `CF-Connecting-IP` counts only when the request came from Cloudflare's own ranges.
- **Stats** for 24 hours, 7 days or 30 days: totals, a series, top links, referrers, countries, devices, browsers, OSes, bots apart.
- **Cron jobs:**
  - `rollup`, daily: raw clicks past `keepDays` (90 by default) become per-link daily totals with their breakdowns, which stats still count;
  - `geo`, monthly: DB-IP's newest list to `data/geo.bin`, picked up within an hour.
- **The admin API** (`/_admin/…`): links, tags, stats, settings, tokens, CSV export and import. It answers only on the server, with the install's token; through Caddy it answers 404.
- **The public API** (`/api/v1/links`, with tokens made in the panel, 120 requests a minute each) was planned for Day 6 and is done here, since it shares the admin API's code.
- **Deploys and updates:**
  - Blue and green, briefly running at once during a deploy, see each other's changes within a second (SQLite's `data_version`).
  - Migrations are numbered and recorded; a database from a newer Links is refused, so a rolled-back version never runs on a schema it doesn't know.
- **Changes from the plan:**
  - No dependencies: Links' own bot and User-Agent rules instead of isbot.
  - The panel draws QR codes; it already has `uqr`.
  - Settings (home, missing, default redirect, keep days) live in Links' database, not env vars, so they change without a restart. The manifest's only env var is `LINKS_ADMIN_TOKEN`.
- **Tests:** 33 in `catalog/links/test`, on the parts and on a running server.
- **Found on the way:** `agent/test/static.test.ts` failed 2 runs in 10. Two static publishes of the same commit in the same millisecond shared a folder, and a failed one deleted the live copy. Folder names now end in random characters; 0 failures in 40 runs.
