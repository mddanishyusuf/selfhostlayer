# Week 1 plan: installer, agent, panel shell

> Decisions behind this plan are in [CLAUDE.md](CLAUDE.md#decisions-2026-10-28). Written 2026-10-28.

**Goal:** on a fresh Ubuntu 24.04/26.04 box, `curl -fsSL https://get.selfhostlayer.com | bash` gives an HTTPS panel at `https://<ip-dashed>.sslip.io` behind a setup token. A test "hello" Node app, created through the agent, runs sandboxed with blue/green switching, without hand-editing anything.

## Repo structure (yarn workspaces)
```
selfhostlayer/
├── installer/
│   ├── install.sh            # entry point, served at get.selfhostlayer.com
│   ├── lib/                  # preflight.sh, packages.sh, caddy.sh, node.sh,
│   │                         # users.sh, hardening.sh, panel.sh, finish.sh
│   └── test/                 # e2e: run on a fresh VM, then assert
├── agent/                    # root helper (TypeScript, bundled to one file)
│   ├── src/
│   │   ├── server.ts         # unix socket, newline-delimited JSON
│   │   ├── dispatch.ts       # action name → handler (the allowlist)
│   │   ├── validate.ts       # slug/port/version/sha validators
│   │   ├── exec.ts           # execFile only, never a shell
│   │   ├── audit.ts          # append-only audit log
│   │   ├── actions/          # app, unit, env, proxy, node, logs, system
│   │   └── templates/        # app-unit.ts, site-caddy.ts (pure functions)
│   └── test/                 # template snapshot tests + validator tests
├── panel/                    # Next.js + SQLite + Tailwind v4 + shadcn/ui, runs as `layer`
├── packages/
│   ├── protocol/             # shared action types + schemas (agent and panel)
│   └── cli/                  # `layer` CLI: ps, logs, restart, repair, reset-admin
├── system/                   # layer-agent.service, layer-panel.service, Caddyfile.base
├── manifest/                 # layer.yaml spec + JSON schema
├── docs/
└── .github/workflows/        # shellcheck, tests, e2e on a throwaway VPS, release
```
**The agent has no `node_modules` at runtime.** It's bundled with esbuild, every dependency is pinned and reviewed, and it runs on the pinned Node in `/opt/layer/node`. The threat model is "a malicious npm package", so the root process gets the smallest supply chain possible.

## Layout on the server
| Path | Owner / mode | Purpose |
|---|---|---|
| `/opt/layer/releases/<ver>/` + `current` symlink | root, 755 | One release: `agent/` (agent + CLI), `web/` (panel), `system/` (units). The last 3 are kept |
| `/opt/layer/node/<ver>/` | root, 755 | Node runtimes shared by all apps |
| `/etc/layer/config.json` | root:layer 640 | Box config: public IP, panel domain, port range |
| `/etc/layer/secret.key` | root:layer 640 | Key that encrypts env vars in the panel DB |
| `/etc/layer/apps/<slug>/app.env` | root 600 | App env, injected by systemd. The app has no writable env file |
| `/etc/layer/apps/<slug>/{blue,green}.env` | root 644 | `PORT=`, `HOSTNAME=127.0.0.1`, `NODE_ENV=production` |
| `/var/lib/layer/panel.db` | layer 600 | Panel state |
| `/run/layer/agent.sock` | root:layer 660, dir 750 | Agent socket. Only root and the panel's group can connect |
| `/run/layer-panel/panel.sock` | layer:layer-web 660 | Panel HTTP. `layer-web` has only two members, `caddy` and `layer`, so only Caddy can reach it. A separate dir, so the panel can't touch the agent's socket |
| `/var/lib/layer-agent/archive/` | root 700 | `data/` of deleted apps (`app.delete` with `keepData`) |
| `/opt/layer/runtime` | symlink | The Node version the panel and agent run on |
| `/var/log/layer/audit.jsonl` | root 600 | Audit log the panel can't erase |
| `/srv/apps/<slug>/` | app-slug 750 | `releases/<sha>/`, `blue`→release, `green`→release, `data/` (700) |

## Installer (`installer/install.sh`)
Design rules:
- **Protect against partial downloads:** the whole script is wrapped in `main()`, which is called on the last line, so a cut-off `curl | bash` runs nothing.
- **Idempotent:** re-running it is the repair path.
- `set -Eeuo pipefail`, with every step logged to `/var/log/layer-install.log`.
- Flags: `--domain`, `--email`, `--yes`, `--no-harden-ssh`, `--version`, `--from-tarball <path>`.
- **During development the repo is private**, so a fresh box can't download from GitHub Releases. Build the tarball locally (`scripts/release.sh`), copy the tarball and `install.sh` to the test box with `scp`, and run `install.sh --from-tarball`.

Steps:
1. **Preflight:**
   - It must run as root, on Ubuntu 24.04/26.04 or Debian 12, on amd64 or arm64, with systemd.
   - Ports 80 and 443 must be free. If nginx or Apache is running, stop and explain.
   - At least 10GB of disk. Detect the public IP.
2. **Packages:** `apt` installs curl, ca-certificates, ufw, fail2ban, unattended-upgrades, sqlite3 and jq. Caddy comes from its official apt repo, with the signing key pinned.
3. **Swap:** create a 2GB swapfile with `vm.swappiness=10` if RAM is under 4GB and there's no swap yet.
4. **Node:** download the current LTS (24.x) tarball and verify it against `SHASUMS256.txt`. Install to `/opt/layer/node/<ver>`.
5. **Users:**
   - `layer`: system user with no shell, home `/var/lib/layer`. Add `caddy` to the `layer` group only if the socket permissions need it.
   - `layer-apps`: group for all app users.
6. **Panel and agent:** use `--from-tarball` if given, otherwise download the release tarball from the public release location (decided at launch). Check its sha256, and its minisign signature (stretch goal; required by launch). Unpack it into `releases/<ver>` and switch `current`.
7. **Secrets:**
   - Generate `secret.key` (32 random bytes).
   - Generate a **setup token**. Only its hash is stored, and it expires after 24 hours.
8. **Caddy:**
   - Write `Caddyfile.base`: admin API on a unix socket (not `localhost:2019`), `import /etc/caddy/sites/*.caddy`, and on-demand TLS whose `ask` goes to the panel.
   - Write the panel site for `<ip-dashed>.sslip.io` or `--domain`. Run `caddy validate`, then reload.
9. **Firewall:** ufw default deny inbound, allow 22, 80 and 443.
10. **SSH hardening:**
    - Only if a non-empty `authorized_keys` exists for root or a sudo user, and the user confirms (skipped when non-interactive unless `--yes`).
    - Write `/etc/ssh/sshd_config.d/10-layer.conf` turning off password and keyboard-interactive login. Run `sshd -t` before reloading. Never lock anyone out.
11. **Start services:** enable `layer-agent` and `layer-panel`, then wait for the health checks.
12. **Finish:** print the URL and the setup token in a box, plus `layer status`.

**Risk to check on Day 1:** sslip.io and Let's Encrypt rate limits. If sslip.io isn't on the Public Suffix List, every user worldwide shares one registered-domain limit. Caddy falls back to ZeroSSL by itself. The other fallback is our own `<random>.selfhostlayer.com` subdomains with a tiny DNS service.

## Root helper (`layer-agent`)
**Protocol:**
- Newline-delimited JSON over `/run/layer/agent.sock`.
- Request: `{id, action, params}`. Reply: `{id, ok, result | error}`. Streaming actions send several `{id, chunk}` frames.
- Access control is filesystem permissions: root:layer, mode 660.

**Hard rules:**
- **Every path is built from a validated slug** (`^[a-z][a-z0-9-]{1,30}$`). The panel never sends a path.
- **The panel sends structured fields, never file contents.** The agent renders units and Caddy files from its own templates.
- **`execFile` with an argument array only.** No `sh -c` anywhere in the agent.
- Every call goes to the audit log first: timestamp, action, params with secrets redacted, result.
- Ports are allocated by the agent from a range (e.g. 4000–4999). The panel never picks one.

**Week 1 allowlist** (anything not listed is rejected):
| Action | Params | Does |
|---|---|---|
| `system.info` | none | OS, CPU, RAM, disk, Node versions, Caddy status |
| `node.install` | `version` | Fetch, verify and unpack into `/opt/layer/node` |
| `app.list` | none | Every app with ports, live color and domains, read back from its files (added Day 4 for `layer ps`) |
| `app.create` | `slug` | Run `useradd --system --shell /usr/sbin/nologin --home /srv/apps/<slug> -G layer-apps app-<slug>`, create dirs with the right modes, allocate 2 ports |
| `app.delete` | `slug, keepData` | Stop units, remove units, vhost and user. Archive `data/` unless told otherwise |
| `env.write` | `slug, vars{}` | Validate keys (`^[A-Z_][A-Z0-9_]*$`) and reject newlines in values. Write `app.env` atomically (temp file + rename) |
| `unit.write` | `slug, nodeVersion, startCmd, memoryMax, cpuQuota` | Render `app-<slug>@.service`, then `daemon-reload` |
| `unit.start` | `slug, color, healthPath?, timeoutSec?` | Enable and (re)start `app-<slug>@<color>`, wait until it answers HTTP below 500. Otherwise stop it again and fail `unhealthy` |
| `unit.stop` | `slug, color, force?` | Stop and disable a color. Refuses the live color unless forced |
| `unit.status` | `slug` | Per color: state, enabled, release, port, memory, restarts, live |
| `release.point` | `slug, color, sha` | Atomically point the `blue` or `green` symlink at `releases/<sha>`. Refuses the live color unless forced |
| `proxy.set` | `slug, domains[], color` | Render `sites/<slug>.caddy` with the upstream on that color's port and reload Caddy. Restores the previous file if Caddy refuses it |
| `logs.tail` | `slug, color?, lines, follow` | `journalctl -u app-<slug>@*` streamed back |
| `security.score` | `slug` | Parsed output of `systemd-analyze security` |

Stubbed for Week 2: `build.run` runs as a **transient** `systemd-run` unit with the app user, the same sandbox, `MemoryMax`, and write access only to the release dir. Also `release.prune` and `cache.clean`.

The agent's own unit runs as root but still sandboxed: `ProtectHome=yes`, `PrivateTmp=yes`, and `ReadWritePaths=` limited to `/etc/layer /etc/caddy/sites /etc/systemd/system /srv/apps /opt/layer/node /var/log/layer /run/layer`.

## Panel (`layer-panel.service`)
- `User=layer`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/layer`, empty `CapabilityBoundingSet`.
- Listens on `/run/layer-panel/panel.sock` through a small custom Next.js server calling `listen(path)`, so apps on `127.0.0.1` can never reach it.
- **Week 1 scope:** setup-token page, then create the admin, then mandatory TOTP, login rate limiting, a bare system page showing `system.info`, and the Caddy `ask` endpoint.

### Week 1 screens (UI rules are in [CLAUDE.md](CLAUDE.md#ui-design-vercel-level-clean-and-smooth))
1. **Setup:** a centered 400px card on a plain background with the logo mark, "Set up Self Host Layer", a monospace setup token input, and one primary black button. If the token is wrong, show an inline error, never a toast.
2. **Create admin:** email and password. Then **2FA**: a QR code, the manual key in Geist Mono with a copy button, a 6-digit segmented input, then 8 recovery codes to download.
3. **Login:** the same card, with a TOTP step after the password.
4. **System overview:** the first real dashboard page, used to prove the design system. A top bar (logo, "Overview", avatar menu), then a stat row (CPU, RAM, disk, uptime) in bordered cards with tabular numbers and a small sparkline. Below it, an "Apps" empty state: "No projects yet. Connect GitHub to deploy your first app." (the button is disabled until Week 2).

Set up the design tokens (CSS variables for light and dark), Geist and the shadcn base components on Day 5, so every later week builds on the same look.

## systemd unit template
This is one template per app, with blue and green as instances. Rendered by `agent/src/templates/app-unit.ts`, shown here for an example app `piqo`:
```ini
# /etc/systemd/system/app-piqo@.service. Generated by layer-agent. Run `layer repair` instead of editing.
[Unit]
Description=layer app piqo (%i)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=app-piqo
Group=app-piqo
WorkingDirectory=/srv/apps/piqo/%i
EnvironmentFile=/etc/layer/apps/piqo/app.env
EnvironmentFile=/etc/layer/apps/piqo/%i.env
Environment=PATH=/opt/layer/node/24.11.0/bin:/usr/bin:/bin
ExecStart=/opt/layer/node/24.11.0/bin/node node_modules/next/dist/bin/next start
Restart=on-failure
RestartSec=2
SyslogIdentifier=app-piqo-%i
UMask=0077

# Resources
MemoryHigh=400M
MemoryMax=512M
CPUQuota=100%
TasksMax=256
LimitNOFILE=65536

# Sandbox
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/srv/apps/piqo/data -/srv/apps/piqo/%i/.next/cache
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=EPERM
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
```
Notes:
- **Order of the env files:** systemd lets the later file win, so `blue.env`/`green.env` always override `PORT`.
- **Never `MemoryDenyWriteExecute=yes`.** V8's JIT needs writable, executable memory.
- **Next.js writes at runtime** to `.next/cache` (ISR, image optimization). Other frameworks get their write paths from the framework detector.
- **`AF_NETLINK` is allowed** because `os.networkInterfaces()` needs it. **No `ProcSubset=pid`**, because it hides `/proc/cpuinfo` and `os.cpus()` would return `[]`. **`SystemCallErrorNumber=EPERM`** makes a blocked syscall fail with an error instead of killing the process with SIGSYS. The source of truth is `agent/src/templates/app-unit.ts` and its snapshot test.
- **Known limit:** apps on `127.0.0.1` can still connect to each other's ports (documented in CLAUDE.md).

## Day 1 spike result (2026-10-28)
Run with `scripts/dev-vm.sh spike` on a Multipass VM: Ubuntu 24.04.5, arm64, 2 CPU, 2GB RAM, Next.js 16.4.3, Node 24.13.1. **Everything passed on the first run, with no changes to the template.**

| Check | Result |
|---|---|
| Sandboxed build (`npm install && next build` as `app-hello`, `ProtectSystem=strict`, 1GB cap) | ✓ in 24s |
| Runs as `app-hello`, page renders on port 4001 | ✓ ready in 290ms |
| Write `data/`, `.next/cache`, `/tmp` | ✓ allowed |
| Write the release dir or `/etc` | ✓ blocked (EROFS) |
| Read `/etc/shadow` or `/root` | ✓ blocked (EACCES) |
| Other processes in `/proc` | ✓ hidden (only its own is visible) |
| `os.cpus()` / `os.networkInterfaces()` | ✓ 2 CPUs / works |
| Blocked syscalls in the journal | none |
| Memory | 42MB idle (cap 512MB), 11 tasks |
| `systemd-analyze security` | **1.3 OK** (0 is the safest, 10 the most exposed) |

Still to check: x86 (Hetzner CX), Ubuntu 26.04, Debian 12, and a real app with native modules (`sharp`, `better-sqlite3`).

## Day 2 result (2026-10-28)
Installer steps 2–5 and 9–10 are done: packages and the Caddy repo (key fingerprint pinned), swap, Node, users and directories, ufw, fail2ban, unattended-upgrades, SSH hardening. A fresh install takes about 16s. Tested on fresh Multipass VMs with **Ubuntu 24.04.5 and 26.04.1** (arm64): fresh install, re-run, `installer/test/verify.sh` (25 checks) and the sandbox spike all pass. CI runs the same on an x86 GitHub runner (`install-e2e` job).

Bugs found by testing in the VM, all fixed:
- `sshd -T | awk '…exit'` died of SIGPIPE under `pipefail`. Now the output is captured first, then parsed.
- `getent group sudo wheel` exits 2 when `wheel` doesn't exist (Ubuntu), which aborted the SSH step.
- `/dev/tty` passes `-r` but can't be opened without a terminal, so the prompt crashed. Now that counts as "no".
- The fail2ban default watches `sshd.service` (Ubuntu's unit is `ssh.service`), and on 26.04 Debian's `defaults-debian.conf` overrode our jail. Ours is now `zz-layer.conf`, and failed logins are counted on both releases (OpenSSH 10 `sshd-session` included).
- The 2GB swapfile left exactly 10GB free, which would have failed preflight on the next run. Re-runs now need only 2GB.

SSH hardening was tested for keys present plus `--yes` (applied), a terminal plus "y" (applied), no terminal (skipped, nothing changed), and Hetzner-like `PasswordAuthentication yes` in `50-cloud-init.conf` (our `10-layer.conf` wins). After hardening, password login is refused and key login works.

## Day 3 result (2026-10-28)
The agent is done for the Week 1 actions: `system.info`, `node.install`, `app.create`, `app.delete`, `env.write`. The other allowlisted actions answer `not_implemented`.

- **Code:** `agent/src/` has the server (NDJSON over the unix socket, 1MB line limit, half-close safe for `socat`), dispatch (allowlist, error codes, hides internal errors), the audit log (start and end of each call, env values redacted), a global lock for mutating actions, and `execFile` with absolute binary paths only.
- **Ports** are allocated from the `blue.env`/`green.env` files themselves (4000–4999, also checking nothing else listens). There's no hidden state.
- **env.write** quoting was checked against systemd's real parser: `$`, backticks, `%`, `#`, quotes and spaces all come back exactly.
- **Bundle:** `scripts/build-agent.sh` → `dist/agent/layer-agent.mjs` (24KB, Node built-ins only). Unit: `system/layer-agent.service`.
- **Tests:** 79 vitest tests on the Mac (fake exec checks the exact argv), plus `installer/test/agent-e2e.sh` with 41 checks through the real socket with `socat` (`scripts/dev-vm.sh agent`, and in CI).
- **Agent itself:** 35MB, restarts within a second after `kill -9`, safety score **3.1 OK**. It was 6.2 before limiting it to the 9 capabilities it needs, plus `@system-service` syscalls.

## Day 4 result (2026-10-28)
**Done when "the hello app goes blue→green with no dropped request": passed.** Under constant HTTPS traffic through Caddy (a new connection every 20ms), the deploy blue → green and the rollback green → blue each served ~160 requests with **0 failures**. Traffic switched exactly once and never flipped back.

- **New actions:** `unit.write`, `unit.start` (with a health check), `unit.stop`, `unit.status`, `release.point`, `proxy.set`, `logs.tail` (one-shot or `follow` streaming as `{id, chunk}` frames, stopped when the client disconnects), `security.score`, `app.list`. All 14 allowlisted actions are now implemented.
- **Deploy sequence** (what the panel will run): `release.point` idle color → `unit.start` idle (health check) → `proxy.set` idle → wait 2s for requests in flight → `unit.stop` old. Rollback is the same with the old release.
- **Guard rails:** you can't repoint or stop the live color without `force`. A release that never answers is stopped and disabled again, the site keeps serving the old one, and the crash shows in `logs.tail`. If Caddy rejects a reload, the previous site file is restored.
- **Caddy base** is now an installer step (`installer/lib/caddy.sh`): sites in `/etc/caddy/sites/*.caddy`, admin API on `/run/caddy/admin.sock` (dir 700 caddy), nothing on `localhost:2019`. `verify.sh` checks this.
- **`layer` CLI** (`packages/cli`, bundled to `layer.mjs`, linked as `/usr/local/bin/layer`): `ps`, `status`, `logs [-f]`, `score`, `info`, `call`. It uses the shared `callAgent` client in `packages/protocol`, which the panel will use too.
- **Numbers:** a small Node app in the sandbox uses 10MB, score 1.3. The agent bundle is 42KB and the CLI 8KB.
- **Tests:** 108 unit tests; `installer/test/bluegreen-e2e.sh` (29 checks) runs in the VM and in CI after the agent e2e.

## Day 5 result (2026-10-28)
**Done when "`curl … | bash` on a clean box prints the URL, and the panel loads over HTTPS": passed** (with `--from-tarball` while the repo is private). Fresh VM → installer → box with `https://<ip>.sslip.io` and the setup token → Chrome completes setup, 2FA, recovery codes, dashboard, sign out, sign in.

- **Panel** (`panel/`): Next.js 16 + Tailwind v4 + Geist + lucide, with design tokens for light and dark. Screens: setup token → create admin → TOTP 2FA (QR + manual key + 6-box input with paste/autofill) → recovery codes (shown once, download) → overview (server stats from `system.info`, projects from `app.list`, empty state) → sign in with 2FA or a recovery code.
- **Auth, built on `node:crypto` only:** scrypt passwords (N=2^15), RFC 6238 TOTP (checked against the RFC test vectors, ±1 step, no code reuse), hashed sessions in `__Host-` cookies, sessions limited to 5 minutes until 2FA, rate limiting by IP and email (5 per 15 min), a dummy hash so timing doesn't reveal which emails exist. Secrets are encrypted with AES-256-GCM using `/etc/layer/secret.key`.
- **DB:** Node's built-in `node:sqlite` (no native module, so the same tarball works on x86 and ARM).
- **Production server:** `panel/server.mjs` runs Next's custom-server API on `/run/layer-panel/panel.sock`. The unit uses `Group=layer-web` so systemd creates the socket dir with the right group; the panel's syscall filter blocks `chown`, which is how the first attempt failed.
- **Release:** `scripts/build-release.sh` → `dist/layer-<ver>.tar.gz` (~13MB: agent, CLI, standalone panel, units). It refuses to package dev state; that check caught Next's file tracing including `panel/.dev/` (dev DB, key, token), and `outputFileTracingExcludes` now keeps it out.
- **Installer:** all 12 steps. The new ones are release, secrets (setup token stored only as a sha256, 24h, re-issued on each run until an admin exists), services (health checked *as the caddy user*), the panel site, and the finish box. Every `rm -rf` uses `${var:?}` guards.
- **Numbers:** idle **PSS 172MB** for panel 59 + agent 64 + Caddy 49 (budget 200MB). Page cache is excluded: the agent's cgroup also showed 137MB of reclaimable cache from Node tarballs it had extracted. Panel safety score **1.3**, agent **3.1**.
- **Tests:** 116 unit tests. `panel/scripts/ui-tour.ts` drives Chrome through the whole flow over the DevTools protocol and saves screenshots: locally, against the VM (`scripts/dev-vm.sh ui`) and in CI. `verify.sh` gained 11 panel checks.
- **Bugs the browser tour caught:** the code boxes dropped pasted or autofilled codes (`maxLength=1`), auto-submit sent the code before React rendered it (`flushSync`), and the manual-key box overflowed the card.
- **Moved to Week 3:** the Caddy `ask` endpoint for on-demand TLS, which belongs with custom domains. Also `proxy.set` / the domain flow should wait until the certificate is issued: a brand-new site can answer its first HTTPS request before Caddy has a certificate.

## Day by day
| Day | Work | Done when |
|---|---|---|
| **1** | Repo skeleton, CI (shellcheck, vitest). Spike: run a Next app by hand under the unit above on a throwaway Hetzner box. Check sslip.io rate limits | A hand-written unit serves Next.js with the sandbox on |
| **2** | `installer/` steps 1–5 and 9–10 | Re-running on a fresh VM gives the same state and no errors |
| **3** | Agent: socket server, validators, audit log, `exec.ts`, `system.info`, `node.install`, `app.*`, `env.write` | Calling it with `socat` works, and unknown actions or bad slugs are rejected |
| **4** | Agent: unit and Caddy templates with snapshot tests, `unit.*`, `release.point`, `proxy.set`, `logs.tail`, `security.score`. `layer` CLI calls the agent | The hello app goes blue→green with no dropped request (checked with a curl loop) |
| **5** | Panel: design tokens, Geist, shadcn base, unix socket listener, setup token, admin plus TOTP, rate limit, system page, `ask` endpoint. Installer steps 6–8, 11–12 | `curl … \| bash` on a clean box prints the URL, and the panel loads over HTTPS |
| **6** | E2E script in CI against a throwaway VPS. Measure idle RAM. Document the release layout | E2E is green, idle total is ≤200MB, safety score recorded |

**Not this week:** `get.selfhostlayer.com`, the license and the CLA are launch-time tasks (see the Status section of CLAUDE.md). In Week 1 the e2e test copies the installer to the box with `scp`.
