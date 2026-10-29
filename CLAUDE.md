# Self Host Layer: "Vercel on your own VPS, without Docker"

> Weeks 1–4 built. Read [PLAN-WEEK4.md](PLAN-WEEK4.md) too. When you (Claude) open this folder, read this file, [PLAN-WEEK3.md](PLAN-WEEK3.md), [PLAN-WEEK2.md](PLAN-WEEK2.md), [PLAN-WEEK1.md](PLAN-WEEK1.md) and [RESEARCH.md](RESEARCH.md) before suggesting anything.
>
> **Name:** Self Host Layer. Domain **selfhostlayer.com** (owned). Repo: https://github.com/mddanishyusuf/selfhostlayer. The internal identifier is **`layer`**: CLI `layer`, Linux user `layer`, paths `/opt/layer`, `/etc/layer`, `/var/lib/layer`, units `layer-agent` / `layer-panel`, manifest `layer.yaml`.

## The idea in one paragraph

The user spins up any VPS (Hetzner, DO, anything Ubuntu), runs **one command**, and gets a Vercel-smooth web UI **on their own server**. From that UI they connect GitHub, pick a repo and get a live HTTPS site. Under the hood it's what we do by hand today (`git pull → yarn install → yarn build → restart`, a vhost, TLS, SQLite on disk), done properly: a sandboxed systemd unit per app behind Caddy. **No Docker.** Next to deploys there's a **marketplace of "tools every product needs"** (analytics, link shortener, email marketing, post scheduler, blog, waitlist, status page…) that install onto the same box in one click.

## Why this can win (positioning)

1. **No Docker means more apps per dollar.** Coolify idles at about 500–700MB RAM. Our €4 CX23 runs 13 Node apps on pm2 with 2.2GB to spare. Pitch: *"Run 15 side projects on a $5 box."*
2. **Nothing hidden, no lock-in.** Every app is a normal folder, a plain systemd unit and a readable Caddy file. If you uninstall the panel, your apps keep running. You can SSH in and run `layer logs <app>` / `layer ps` (thin wrappers over `journalctl` / `systemctl`, and the docs show the raw commands). Docker PaaS tools can't make that promise.
3. **The marketplace is for *launching products*, not homelab media servers.** Cloudron and Umbrel sell Nextcloud and Jellyfin. We sell the indie-hacker stack. **We already own several of these tools**: Piqo (analytics, and a self-host fork exists), maillayer-lite (email marketing), postscheduler, blogcms, picker, plus the removed Piqo link shortener. Day-one first-party catalog, no third-party packaging required.
4. **Target user is us:** indie devs and makers running many small Node/Next apps who think Docker is overkill.

**Not competing on:** multi-language polyglot builds, Kubernetes, clusters, enterprise. Coolify and Dokploy own "Docker PaaS". DeployWise and Cleavr are the closest no-Docker rivals (see research).

## Product shape

### Install
```
curl -fsSL https://get.selfhostlayer.com | bash
```
The installer checks the OS (Ubuntu 24.04/26.04, Debian 12) and installs Node as official tarballs with verified checksums into read-only `/opt/layer/node/<version>/` (each app's unit pins its own version; **no fnm, no pm2**), Caddy, the panel itself, swap if RAM is under 4GB, ufw (22/80/443), fail2ban, and unattended-upgrades. It finishes by printing `https://<ip>.sslip.io` (or a temporary subdomain) with a one-time setup token. **The panel is only reachable over HTTPS after first-run setup.**

### Core features (v1)
- **Projects from GitHub** via a **GitHub App**, not personal tokens. It gives repo access, push webhooks, and commit status checks, and it solves exactly the "no git credentials on the new box" problem we hit on 2026-10-27.
- **Framework detection:** Next.js, Vite/static, Express/Fastify/Hono, Astro, Nuxt, Remix. Detect from `package.json` and the lockfile (yarn/pnpm/npm/bun). Allow overrides: build cmd, start cmd, port, Node version, root dir (monorepos).
- **Atomic releases:** build into `releases/<sha>/`, shared `data/` and `.env` symlinked in, flip a `current` symlink, blue/green restart (zero downtime; see Security plan). **One-click rollback** = flip the symlink back. Keep the last N releases.
- **Build queue:** one build at a time on small boxes, with a memory guard and yarn cache cleanup (the CX23 hit 89% disk from yarn cache). Live build logs streamed to the UI.
- **Domains + TLS:** add a domain, the panel shows the DNS record to create, **verifies DNS points here before switching** (prevents the Cloudflare-521 we hit on superdevpro), and issues a cert automatically. Caddy's on-demand TLS makes this nearly free; Piqo's custom-domain feature already uses it.
- **Env vars UI** (encrypted at rest), **logs** (journald per app, Caddy access/error), **metrics** (CPU, RAM, disk per app plus the box), **cron jobs** per project (we have lots: picker sync, Piqo jobs).
- **Databases (native, no Docker):** SQLite first-class (backups that copy `-wal`/`-shm` correctly plus an integrity check, which is our backup-db pattern). Redis, Postgres and MySQL as apt-installed services with one click.
- **Backups:** scheduled to S3/R2/B2. SQLite snapshots plus uploads folder plus env.
- **Notifications:** deploy failed, app crash-looping, disk >80%, cert renewal failed. Email, Telegram, Discord. (We already built Telegram alerts for Piqo.)
- **Server migration assistant (killer feature, later):** "Move this app to another server": build there, stop, copy data with an integrity check, start, wait for DNS, verify, delete on the old box. That's literally what we did by hand for 13 apps.

### Marketplace
- An **app manifest** (`layer.yaml` or a `layer` field in package.json): runtime and version, build/start commands, port, required env (with generated secrets), required services (`redis`, `postgres`, `sqlite`), healthcheck path, cron jobs, data dirs to back up, upgrade/migrate command.
- **First-party apps first** (ours, already Node + SQLite): analytics (Piqo self-host), email marketing (maillayer-lite), post scheduler, blog CMS, link shortener, waitlist, status page, feedback board, forms.
- **Curated third-party apps** that run natively on Node or as a single Go binary. Examples to check: Umami (analytics), Listmonk (Go, email), Postiz (social posts), Ghost (blog), Uptime Kuma (status), Formbricks, n8n. **Avoid** apps that are hard to run without Docker (Plausible = Elixir + ClickHouse, anything with a JVM).
- **Cross-app glue later:** Analytics auto-injected into every project you deploy, one SSO login for all marketplace apps, shared SMTP settings.
- **Community submissions later:** manifest in a public GitHub repo, reviewed via PR (like Homebrew taps).

### Panel's own architecture
- **Two processes:** a **web UI** (Next.js + SQLite, our stack) running as an **unprivileged user**, and a small **agent/daemon** with the privileges to run builds, write vhosts, manage systemd units and certs. The UI talks to the agent over a local unix socket with an allowlisted command set. Never let the web process run arbitrary shell as root.
- **Per-app Linux user plus a systemd unit per app.** See the Security plan below. Today on our boxes everything runs as root under one pm2; the product must do better.
- Self-update of the panel, plus a "repair" command that re-applies config if someone edits units or Caddy files by hand.
- **Multi-server (v2):** one panel manages several boxes over SSH plus an agent, like Forge. Keep the agent protocol transport-agnostic so this is a transport swap, not a rewrite.
- **Idle budget:** panel + agent + Caddy together **≤200MB RAM idle**. It's the headline number against Coolify, so measure it in CI.

### UI design: Vercel-level clean and smooth
The panel should feel like Vercel's dashboard: calm, monochrome, fast. Take the *feel*, never Vercel's logo, triangle mark or exact branding.
- **Stack:** Tailwind v4 + shadcn/ui (Radix primitives) + lucide icons. **Geist Sans / Geist Mono** (OFL, `geist` npm package).
- **Color:** neutral gray scale only. Background `#fff` / `#0a0a0a`, text `#171717` / `#ededed`, 1px borders (`#eaeaea` / `#1f1f1f`). One accent (blue) for links and focus rings. Status colors only: green = ready, amber = building, red = error, gray = queued or cancelled. Light, dark and system themes; follow the system by default.
- **Shape:** 1px borders instead of shadows, 6–8px radius, generous whitespace, max-width ~1200px content column, 14px base text, tabular numbers for metrics.
- **Layout:** a top bar with a project switcher, then project tabs (Overview · Deployments · Logs · Domains · Env · Settings). Deployment rows show a status dot, commit message, short sha, branch and "2m ago".
- **Motion and feedback:** 150ms ease-out transitions, skeletons instead of spinners, optimistic updates, toasts for results, a ⌘K command menu.
- **Logs:** monospace, streaming, auto-scroll that pauses when you scroll up, ANSI colors, copy and download buttons.
- **Copy:** short and plain ("Deploying…", "Ready", "Build failed: exit code 1"). Every destructive action needs you to type the app name to confirm.

## Security plan (no Docker)

**Threat model (decided 2026-10-28):** single-owner box. The person who installs the panel hosts only *their own* projects; there are no hostile tenants. The danger is **one app getting compromised** (a vulnerable or malicious npm package, an RCE bug in the app) and then spreading to the other apps, the panel, or the whole server. Separate VMs for strangers' code are out of scope.

**Key fact:** Docker's isolation is just Linux kernel features (namespaces, cgroups, seccomp). systemd uses the same features natively, so we get most of it without images.

1. **A Linux user per app:** `useradd --system --shell /usr/sbin/nologin --home /srv/apps/<slug> app-<slug>`. There's no password and no SSH login. The app folder is `750` and owned by that user; SQLite files are `600`. **Builds (`yarn install`, `yarn build`) also run as that user**, so a bad postinstall script is contained.
2. **A systemd unit per app** (**decided 2026-10-28: systemd, no pm2 at all**), with sandboxing turned on by default. The full template is in [PLAN-WEEK1.md](PLAN-WEEK1.md).
   - `User=app-<slug>`, `NoNewPrivileges=yes`, `CapabilityBoundingSet=` (empty)
   - `ProtectSystem=strict`, `ReadWritePaths=/srv/apps/<slug>/data` plus framework runtime caches (Next.js needs `.next/cache`), `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`
   - **Never** `MemoryDenyWriteExecute=yes`, because V8's JIT needs it off.
   - `SystemCallFilter=@system-service`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`
   - `MemoryMax=` / `CPUQuota=` per app, so one runaway app or build can't freeze a small box
   - Show `systemd-analyze security app-<slug>` as a per-app **safety score badge** in the UI.
   - Zero-downtime deploys with **blue/green ports**: one template unit `app-<slug>@.service` with instances `blue` and `green`. Start the new release on the alternate port, health-check it, switch the Caddy upstream, then stop the old one. Logs come from journald.
3. **Network:**
   - Apps bind to `127.0.0.1` only, and only Caddy listens publicly. ufw allows 22, 80 and 443.
   - Every app gets its own Postgres role and database, and its own Redis ACL user and password. Nothing shares credentials.
   - Optional per-app `IPAddressDeny=`/`IPAddressAllow=` for apps that shouldn't make outbound calls.
   - Caddy's admin API listens on a unix socket, not `localhost:2019`, and the panel listens on a unix socket, not a TCP port. Otherwise any compromised app could reach them.
   - Known v1 limit: apps can still connect to each other's localhost ports. Per-app credentials on Redis and Postgres cover the services.
4. **Secrets:** env vars are encrypted at rest in the panel DB. On disk they exist only as `/etc/layer/apps/<slug>/app.env` (root, `600`), which systemd injects into the process. The app gets the env but has no file it can rewrite. They're never shown in build logs. Honest limit: the panel can decrypt everything, so a compromised panel means all secrets are exposed.
5. **The panel (the highest-value target):**
   - The web UI runs as its own unprivileged user (`layer`).
   - A small root helper exposes only an allowlisted set of actions over a unix socket: create or delete an app user, write a unit or vhost, start or stop a unit, issue a cert, run a build as the app user. **No arbitrary shell.**
   - Login: first-run setup token, mandatory 2FA, rate-limited login, and an option to restrict the panel to an IP allowlist or Tailscale.
   - Audit log of every privileged action.
6. **Server hardening done by the installer:**
   - SSH keys only, with password and root password login disabled (after confirming a key works).
   - fail2ban and unattended-upgrades.
   - Swap on boxes under 4GB, so `next build` can't OOM-kill the box.
7. **Recovery:** scheduled off-box backups (S3/R2/B2) of SQLite (with `-wal`/`-shm` and an integrity check), uploads and env. The worst case should be "restore last night", never "lost everything".
8. **Optional extra hardening (later):** AppArmor profiles, Landlock. systemd covers about 90% of the benefit.

**Honest limit:** all apps share one kernel. A kernel exploit could escape, and that's equally true with Docker. Only separate VMs fix it, and that's out of scope for the single-owner threat model.

**Marketing angle:** most people running apps by hand with pm2 run everything as root. Make "every app sandboxed, memory-limited and scored, with no Docker" a headline feature.

## Business model
- **License: deferred until the tool works (decided 2026-10-28).** The repo is private and has one author, so there's no LICENSE file (all rights reserved). Leading option: an **AGPL-3.0** core plus a **CLA** (CLA-assistant), so Pro can ship as a separate proprietary package, and an **MIT** manifest spec. **Decide before** making the repo public or accepting any outside contribution.
- **Open-core:** free single-server panel (open source, builds trust and GitHub stars, which is how Coolify and Dokploy grew).
- **Paid:** Pro license per panel (~$5–9/mo or a lifetime deal) for multi-server, teams/roles, S3 backups, preview deploys, migration assistant. **Paid marketplace apps** (Piqo Pro etc.; Piqo already has a self-hosted license flow at /self-hosted/licenses). Optional hosted control plane later.
- Distribution: this doubles as a **funnel for our own products**. Every install sees analytics/email/scheduler one click away.

## Biggest risks
1. **Weaker isolation than VMs:** native apps share the kernel. Mitigated by the Security plan above (per-app users plus systemd sandboxing). Be honest about the limit in the docs.
2. **"Works on my box" builds:** native deps (sharp, better-sqlite3, canvas) and OOM during `next build` on 2–4GB boxes. Mitigate with swap, a build memory cap, and prebuilt binaries.
3. **Marketplace maintenance:** every native app needs an upgrade path. YunoHost shows this burden. Start with apps we own.
4. **Competition:** Coolify is free with 50k stars. Our wedge has to stay sharp: *lightweight + native + product-launch toolkit*, not "everything".
5. **Security of a panel on the public internet:** 2FA, setup token, an option to bind the panel to a Tailscale/IP allowlist, rate limiting.

## MVP plan (~6 weeks, solo)
- **Week 1:** Installer, root agent, panel user, systemd unit template, panel shell (setup token + 2FA). Detailed day-by-day plan in [PLAN-WEEK1.md](PLAN-WEEK1.md).
- **Week 2:** GitHub App (manifest flow), tarball fetch, framework detection, sandboxed builds, deploy pipeline, push-to-deploy, free `<app>.<panel-host>` URLs. Plan: [PLAN-WEEK2.md](PLAN-WEEK2.md).
- **Week 3:** Custom domains with DNS verification and certificate status, crons, alerts. Plan: [PLAN-WEEK3.md](PLAN-WEEK3.md). (Env vars, rollback and push-to-deploy were done in Week 2.)
- **Week 4:** SQLite/Redis/Postgres services, encrypted backups to S3/R2 with restore, email alerts. Plan: [PLAN-WEEK4.md](PLAN-WEEK4.md). (Crons and alerts were done in Week 3.)
- **Week 5:** Marketplace v0: manifest format plus 3 first-party apps (Piqo self-host, maillayer-lite, post scheduler).
- **Week 6:** Landing page, docs, dogfood by **moving the 7 apps still on mvpstack-apps (DigitalOcean) with it**. That's the launch story: "we closed our DigitalOcean account with this."

## Decisions (2026-10-28)
1. **Name:** Self Host Layer, selfhostlayer.com. Internal identifier `layer`.
2. **Proxy:** Caddy (automatic TLS, on-demand certs with an `ask` endpoint, generated per-app files in `/etc/caddy/sites/`).
3. **Scope:** Node + static only in v1. Package managers yarn/pnpm/npm/bun; the runtime is always Node. Marketplace Go apps use a `runtime: binary` manifest type (download, verify, run, no build).
4. **License:** deferred while the repo is private (see Business model). Leaning AGPL-3.0 + CLA.
5. **Topology:** panel on the same box for v1.
6. **Process manager:** systemd unit per app. No pm2.
7. **Node runtimes:** official tarballs with verified checksums in `/opt/layer/node/<version>/`. No fnm.
8. **UI:** Vercel-like (see UI design above).

## Status
**2026-10-28:** Brainstorm done, all open questions decided except the license (deferred). Repo is **private** (github.com/mddanishyusuf/selfhostlayer). **Day 1 done:** skeleton, validators, unit template, installer preflight, CI. The sandbox spike passed in a local VM (safety score 1.3, 42MB idle; see [PLAN-WEEK1.md](PLAN-WEEK1.md#day-1-spike-result-2026-10-28)). Local testing uses Multipass via `scripts/dev-vm.sh` (macOS needs the Local Network permission for VS Code). **Day 2 done:** installer server setup, verified on Ubuntu 24.04 and 26.04 ([results](PLAN-WEEK1.md#day-2-result-2026-10-28)). **Day 3 done:** root agent with the first 5 actions, 41-check socket e2e, agent score 3.1 ([results](PLAN-WEEK1.md#day-3-result-2026-10-28)). **Day 4 done:** blue/green deploy and rollback under traffic with 0 failed requests, all 14 agent actions, `layer` CLI ([results](PLAN-WEEK1.md#day-4-result-2026-10-28)). **Day 5 done:** panel (setup token → admin → TOTP → recovery codes → dashboard), full installer with release tarball, browser tour in CI; idle PSS 172MB ([results](PLAN-WEEK1.md#day-5-result-2026-10-28)). **Week 2 planned** ([PLAN-WEEK2.md](PLAN-WEEK2.md)): one GitHub App per server, tarball fetch, `<app>.<panel-host>` URLs, push-to-deploy in Week 2, examples in github.com/mddanishyusuf/selfhostlayer-examples. Test VPS: 1GB Hetzner, Ubuntu 26.04 x86 (37.27.25.45). **Week 2 Day 1–2 done:** examples repo, real Let's Encrypt on the VPS, sandboxed GitHub-tarball builds for npm/pnpm/yarn/bun ([results](PLAN-WEEK2.md#day-2-result-2026-10-28)). **Day 3 done:** framework detection, static sites served by Caddy with no process, free `<app>.<ip>.sslip.io` URLs with real certificates. **Day 4 done:** GitHub App manifest flow, installations, repo list, signed webhooks (tested against a fake GitHub; real click-through pending on the VPS). **Day 5 done:** deploy pipeline through the UI (import → build → live URL, live logs, redeploy, instant rollback, push-to-deploy). **Day 6 done: Week 2 complete** (configure step, env vars editor, delete, breadcrumbs). Left for the user: connect real GitHub on the VPS panel and push a commit. **User's first real app is live on the VPS** (`reduce-png-size`, from GitHub). After fixing GitHub's new 520-char stateless installation tokens in `source.fetch`. **Week 3 planned** ([PLAN-WEEK3.md](PLAN-WEEK3.md)): custom domains verified via public DNS before going live, crons as systemd timers, alerts via Telegram/Discord/webhook (email in Week 4), www → apex. **Week 3 Day 1–6 done** ([results](PLAN-WEEK3.md#day-56-result-2026-10-29)): custom domains with DNS checks and certificate status, crons as systemd timers with run history, alerts (deploy failed, crash loop, disk, certificates, failed crons) to Telegram/Discord/webhook. Deployed to the VPS. **Week 4 planned** ([PLAN-WEEK4.md](PLAN-WEEK4.md)): encrypted backups to S3-compatible storage, a Redis per app, shared Postgres with a role per app, email alerts. **Week 4 Day 1 done:** SQLite-safe snapshots and restore in the agent ([results](PLAN-WEEK4.md#day-1-result-2026-10-29)). **Week 4 done** ([results](PLAN-WEEK4.md#day-26-result-2026-10-29)): encrypted backups to any S3-compatible bucket with one-click restore (SQLite checked, Postgres dumped, the panel itself included), a Redis per app, a Postgres role and database per app, email alerts over SMTP. Deployed to the VPS.

**Launch-time tasks (not now):** choose the license plus CLA, make the repo public (or publish releases somewhere public), and serve `get.selfhostlayer.com` from GitHub Pages (needs a public repo or GitHub Pro). Deploy it from tagged releases only, with a verified domain and HTTPS enforced.
