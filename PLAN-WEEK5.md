# Week 5 plan: marketplace v0

> Drafted 2026-10-29. Builds on [PLAN-WEEK4.md](PLAN-WEEK4.md); product context in [CLAUDE.md](CLAUDE.md). The redesign (done 2026-10-29) left the Integrations page as "Coming soon"; this week makes it real.

**Goal:** from Integrations, install one of our own apps in one click and get a live HTTPS app: secrets generated, data in `DATA_DIR`, backups and domains working like any other project. Three first-party apps in the catalog: **Piqo** (analytics), **maillayer** (email marketing) and **Scheduling Layer** (social post scheduler).

**Correction to the original plan:** `postscheduler` is the postscheduler.com directory site, not an app. The self-hosted scheduler is **`schedulinglayer`** (Twitter/X, Threads, LinkedIn).

## What the three apps need (read from their repos, 2026-10-29)
| App | Repo (all private) | Runs as | Data | Needs | Ready? |
|---|---|---|---|---|---|
| Piqo | `piqo-selfhost`, tag v0.1.5 | Next.js + custom `server.js`, Node ≥ 22, reads `HOST`/`PORT` | SQLite at `DATABASE_PATH`, GeoIP file | `AUTH_SECRET` (generated), `APP_URL`; optional license key, MaxMind key, SMTP | Yes. Migrates itself on start, `/api/health` exists |
| maillayer | `maillayer-pro`, tag v1.7.0 | Next.js + `server.js`, reads `HOST`/`PORT` | SQLite at `DATABASE_PATH`, logs, its own backups dir | `AUTH_SECRET`, `APP_URL`; it can drive Caddy itself, which must be off here (`MAILLAYER_NO_CADDY=1`) | Yes. Migrates on start, `/api/health` exists, GeoIP download skips without a key |
| Scheduling Layer | `schedulinglayer`, no tags | Next.js + `server.js` **hard-coded to port 3000 on all interfaces** | SQLite through Prisma (`DATABASE_URL=file:…`), uploaded media | `ENCRYPTION_KEY` (generated); optional DigitalOcean Spaces keys | **Needs a small fix:** read `HOST`/`PORT`, and run `prisma migrate deploy` before start. Also has `app.db`/`dev.db` committed: check they hold no real tokens |

## Decisions (recommended 2026-10-29, change any of them)
1. **An installed app is a normal project.** Installing creates a project from the manifest and deploys it through the existing pipeline, so domains, env, logs, backups, crons, rollback and delete work unchanged. The project remembers its catalog entry and version.
2. **The manifest is `layer.yaml` in the app's repo** (or a `"layer"` key in `package.json`), parsed with the `yaml` package (no dependencies). It says how to run the app: Node version, build and start commands, health path, memory, env (asked, generated or templated), services (`redis`, `postgres`), crons, writable folders, and an optional `migrate` command. The spec gets its own page and an MIT license, as planned.
3. **Env templates are resolved at every deploy:** `${APP_URL}` (the app's main domain, so adding a custom domain updates it), `${DATA_DIR}`, `${SLUG}`. Generated secrets (`generate: hex-32`, `base64-48`) are made once at install and stored encrypted like other env vars.
4. **The catalog ships with the panel:** `catalog/<app>.yaml` in this repo holds the listing (name, category, description, icon, rough RAM) and a pinned source. A panel update can bring newer app versions; the project then shows "Update to vX".
5. **Updates take a backup first** (when backups are on), then deploy the new version. Rollback stays instant, but a database migration may not undo itself, so the backup is the real undo.
6. **`migrate` runs before traffic switches:** a new agent action runs it once in the new release, as the app user, in the app's sandbox with its env and `DATA_DIR`. If it fails, the old version keeps serving. Piqo and maillayer don't need it (they migrate on start); Scheduling Layer does.
7. **Where the code comes from. Your call:** the three repos are private, so other people's servers can't fetch them.
   - **This week:** the catalog builds from your GitHub repos at a pinned tag. That works on your own box once the GitHub App is installed on those repos, and it reuses the deploy pipeline unchanged.
   - **For launch, pick one:** (a) prebuilt release tarballs (recommended: the apps' CI already builds Docker images, so it adds one artifact per architecture, and installs skip `next build`, which is slow on a 1GB box), or (b) make the repos public, with the license key still gating paid features.
8. **Automated tests use a public example:** a `catalog-demo` app in `selfhostlayer-examples` uses every manifest feature (asked and generated env, templates, Redis, a cron, `migrate`). The VM tour installs it; the private apps are tested on your VPS.

## Day by day
| Day | Work | Done when |
|---|---|---|
| **1** | Manifest spec, parser and validator (clear errors per field), catalog format, `catalog-demo` example with a `layer.yaml` | Unit tests cover every field and error; the example's manifest validates |
| **2** | Pipeline: env templates resolved per deploy, `migrate` agent action before the switch, services and crons created from the manifest | VM e2e: `catalog-demo` deploys with a generated secret, Redis and a cron; a failing `migrate` leaves the old version serving |
| **3** | Integrations page: catalog list, app page (what it does, what it needs, RAM), install form (asked values; generated ones hidden), install creates the project and deploys; "Installed · Open" state, catalog badge on the project | VM tour: install `catalog-demo` from Integrations and reach it over HTTPS |
| **4** | Updates ("Update to vX", backup first), projects imported from GitHub that contain a `layer.yaml` get its settings applied, manifest docs | An update deploys the new version after a backup; a GitHub import with `layer.yaml` needs no manual settings |
| **5** | The three apps: add `layer.yaml` to each repo, fix Scheduling Layer's `HOST`/`PORT` and migrations, tag releases, catalog entries | Each installs on the VPS from Integrations and answers on its health path |
| **6** | VPS run-through, tour screenshots, results in this file | All three live on the VPS; the VM tour passes |

## Needs from you
1. **OK to change the three app repos:** add `layer.yaml` (and tags) to each; in `schedulinglayer`, read `HOST`/`PORT` and run migrations. Small PRs you can review.
2. **Install the GitHub App on those three repos** on the VPS panel (Settings → GitHub → Install on more repositories), so the box can fetch them.
3. **Decision 7 for launch:** tarballs or public repos. Not needed until Week 6.
4. **Optional:** a Piqo and a maillayer license key for the VPS test.
