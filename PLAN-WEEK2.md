# Week 2 plan: GitHub → build → live URL

> Agreed 2026-10-28. Builds on [PLAN-WEEK1.md](PLAN-WEEK1.md); product context in [CLAUDE.md](CLAUDE.md).

**Goal:** from a fresh install, connect GitHub, pick a Next.js repo and get a live HTTPS URL with build logs streaming in the UI. A push to `main` redeploys with zero downtime, and rollback is one click.

## Decisions (2026-10-28)
1. **One GitHub App per server, created with GitHub's manifest flow.** The app belongs to the user; its private key is stored encrypted in the panel DB. No central service of ours holds keys or relays webhooks.
2. **Code comes in as a tarball through the GitHub API, not `git clone`.** The panel creates a read-only, single-repo installation token (expires within an hour) for each fetch. No git credentials or `.git` on the box. The archive is unpacked as the app user inside the sandbox. The agent only accepts `https://api.github.com/repos/<owner>/<repo>/tarball/<sha>`.
3. **Every app gets a free HTTPS URL `<app>.<panel-host>`**, e.g. `piqo.203-0-113-7.sslip.io` (sslip.io supports wildcards). Custom domains stay in Week 3.
4. **Push-to-deploy moves into Week 2** (default branch only), because the webhook endpoint exists for the GitHub App anyway. PR previews stay Pro, later.
5. **Example apps live in the public repo [mddanishyusuf/selfhostlayer-examples](https://github.com/mddanishyusuf/selfhostlayer-examples)**, one folder per framework, so tests use the real tarball path and a monorepo root dir, with no test-only code in the agent.

**Test box:** a 1GB VPS (the low end of the pitch). Builds will swap; resize to 2GB if that gets painful.

## Agent: new actions
| Action | Does |
|---|---|
| `source.fetch` | Download the GitHub tarball and unpack it into `releases/<sha>` as the app user, sandboxed (transient unit) |
| `build.run` | Install + build in a transient `layer-build-<slug>` unit: package manager from the lockfile (`npm ci`, `yarn install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `bun install --frozen-lockfile`; yarn/pnpm via corepack), app env injected, memory cap (default 1.5GB), CPU cap, 20 min timeout, output streamed, refuses to start under 15% free disk |
| `build.cancel` | Stop a running build |
| `static.publish` | Static sites: copy the output to a root-owned folder Caddy serves with `file_server` (no Node process) |
| `release.prune` | Keep the newest N releases (default 5), never the live ones |
| `cache.clean` | Cap the per-app package cache (default 1GB) |

Builds get their **own lock** (one build at a time), separate from the global lock, so a long build never blocks `proxy.set` or `unit.*` for other apps.

## Panel
- **Framework detection** (plain functions, unit-tested): Next.js (`next start`, writable `.next/cache`), Vite/CRA/static Astro (static), Astro SSR (`node dist/server/entry.mjs`), Nuxt (`node .output/server/index.mjs`), Remix/React Router 7 (`react-router-serve build/server/index.js`), Express/Fastify/Hono (`npm start`). Node version from `.nvmrc` / `.node-version` / `engines`. Every value can be overridden: root dir, install/build/start, Node version, health path, memory.
- **GitHub App:** manifest flow with a one-time `state` (CSRF), encrypted private key, installation callback, repo list with search, installation tokens on demand, signed webhook `/api/github/webhook` (HMAC check, each delivery processed once, `push` + `installation` events). Plus a "check for new commits" fallback if webhooks can't reach the panel.
- **Deploy pipeline:** `deployments` table; worker runs `source.fetch` → `build.run` → `release.point` (idle color) → `unit.start` (health) → `proxy.set` → drain → `unit.stop` (old) → `release.prune`. Any failure keeps the old version live. Build logs saved to a file and streamed to the browser (SSE). Rollback is instant when the release is still on disk.
- **UI:** Connect GitHub → New project (repo picker) → Configure (detected settings + env vars before the first deploy) → Deployment page (live log with ANSI colors, auto-scroll that pauses, per-step timings) → Project page (live URL, deployments list, rollback). The overview links to projects.

## Day by day
| Day | Work | Done when |
|---|---|---|
| **1** | Week 1 wrap: real x86 VPS install with Let's Encrypt, browser tour fails on unexpected reloads, README install/uninstall guide. Build lock. Fill the examples repo | Real Let's Encrypt panel on the VPS; example apps on GitHub, each building locally |
| **2** | Agent: `source.fetch`, `build.run` (streaming, cancel, timeout, disk guard, caches), `release.prune`, `cache.clean` | VM e2e builds every example from its GitHub tarball, sandboxed; the broken one fails cleanly |
| **3** | Framework detection + start presets, `static.publish` + Caddy `file_server`, free `<app>.<panel-host>` URLs | Detection tests pass for every example; a static site serves with no Node process |
| **4** | GitHub App: manifest flow, encrypted keys, installs, repos, tokens, signed webhook | Connect GitHub from the VM panel; repos are listed |
| **5** | Deploy pipeline: deployments table, worker, saved + streamed logs, rollback | Repo → live URL in the VM; instant rollback |
| **6** | UI pages, push-to-deploy, extended browser tour | Fresh install → connect → Next.js repo → live URL → push → zero-downtime redeploy |

## Findings from building the examples (Day 1)
All six examples were built from clean copies the way the server will, with frozen-lockfile installs. Next.js, Vite, Express, Astro and Nuxt build and answer their health check; `broken` fails with `Could not resolve "./does-not-exist.js"`. That surfaced four rules for `build.run`:
- **npm:** run `npm ci`, and if npm says the lockfile is "not in sync", fall back to `npm install` with a warning in the log. npm 11.8 writes Nuxt lockfiles that `npm ci` rejects even when regenerated from scratch; `nuxt/` keeps such a lockfile as the test case.
- **pnpm 11+** fails a frozen install when a dependency's install script isn't approved (`ERR_PNPM_IGNORED_BUILDS`). Show that message clearly. Real repos approve them in `pnpm-workspace.yaml` (`allowBuilds`), as `vite/` does.
- **bun** isn't bundled with Node or corepack, so builds need a bun binary: install it like Node (official release, checksum verified, read-only under `/opt/layer/tools/bun/<version>`).
- **Bind address:** Astro's Node adapter and Nuxt/Nitro read `HOST`, not `HOSTNAME`, so the per-color env file gets `HOST=127.0.0.1` too (otherwise they may bind to `localhost`/IPv6 and fail the 127.0.0.1 health check).
- **Tarball URL:** `api.github.com/repos/<owner>/<repo>/tarball/<sha>` answers with a 302 to `codeload.github.com`. The agent follows exactly that redirect and refuses any other host.

## Findings from the real VPS (Day 1)
1GB Hetzner box, Ubuntu 26.04.1, x86_64, 1 CPU. Real Let's Encrypt certificate for `37-27-25-45.sslip.io` on the first try. `verify.sh` and the blue/green test pass (≈170 requests per switch, 0 failed). Two bugs that the VM couldn't show:
- **Installer order:** `caddy` was added to `layer-web` only in the panel-site step, after the caddy-user health check, so a fresh box failed at "Starting services". Now `setup_users` adds it, before Caddy restarts.
- **`RestrictSUIDSGID=yes` breaks GNU tar on 26.04:** systemd blocks `openat2()` with ENOSYS under that setting, and tar there uses `openat2()` without falling back ("Cannot open: Function not implemented"). Removed from the agent unit. **Day 2 impact:** `source.fetch` unpacks as the app user; either its transient unit leaves out `RestrictSUIDSGID`, or the unpacking happens in Node (whose `fs` uses `openat`) rather than with the tar binary. App runtime units keep it.

## Day 2 result (2026-10-28)
**Done when "VM e2e builds every example from its GitHub tarball, sandboxed; the broken one fails cleanly": passed**, in the VM (24.04, arm64) and on the real 1GB VPS (26.04, x86, 1 CPU). `installer/test/build-e2e.sh` has 46 checks; on the VPS, Next.js and Nuxt build in about 20s each, the others in under 6s.

- **New agent actions:** `source.fetch`, `build.run` (install and build as two streamed steps with `::layer::step` markers), `build.cancel`, `release.prune`, `cache.clean`, `tool.install` (bun). `unit.write` takes a `rootDir` for monorepos. The per-color env now also sets `HOST`.
- **Rule: root never touches files in an app's tree while the app can run.** Unpacking, building, pruning and cache cleanup all run as the app user in a transient sandbox (`agent/src/sandbox.ts`); the tarball reaches `tar` through stdin. Root only downloads, sending the token to `api.github.com` and following only the 302 to `codeload.github.com`.
- **Fixed a latent root bug:** `ensureDir` used to `chown` through symlinks, so a compromised app could swap `releases/` for a link to `/etc` and get root to hand it over on the next `app.create`. It now opens the directory with `O_NOFOLLOW` and changes it through the descriptor.
- **Build sandbox, checked on real boxes:** a build can't write `/etc`, read `/etc/shadow` or list another app's folder, and runs as its own user with the app's env. `%` and `$` in commands reach bash unchanged. Builds run at low CPU and IO priority (`CPUWeight=20`, `Nice=10`) so live apps stay responsive.
- **Bug the e2e caught:** a cancelled build reported success, because systemd counts the SIGTERM from `systemctl stop` as a clean exit. The cancel flag is now checked before the exit code.
- **Disk guard** (default 15% free, configurable): it refused the unit tests on a Mac with 6% free, so tests set it to 0.
- **Tests:** 135 unit tests (77 in the agent), plus `build-e2e.sh` in the VM, on the VPS and in CI.

## Known limits
- The VM has no public IP, so GitHub can't deliver webhooks to it: push-to-deploy is tested on the VPS. Everything else works in the VM.
- Builds have outbound network access (npm needs it). A malicious install script stays inside the app user's sandbox but can make outbound connections during the build. A per-app "no outbound network" option comes later.
