# Self Host Layer

Vercel on your own VPS, without Docker. Private while in development. Read [CLAUDE.md](CLAUDE.md) for the product and [PLAN-WEEK2.md](PLAN-WEEK2.md) for the current plan.

## Install on a server

Needs a fresh Ubuntu 24.04/26.04 or Debian 12 box (x86_64 or arm64, systemd, 10GB free disk; 1GB RAM works) with ports 80 and 443 free.

While the repo is private there's no public download, so build the release locally and copy it over:

```sh
bash scripts/build-installer.sh && bash scripts/build-release.sh 0.1.0
scp dist/install.sh dist/layer-0.1.0.tar.gz root@<server>:
ssh root@<server> bash install.sh --from-tarball layer-0.1.0.tar.gz
```

It finishes with a box showing the panel URL (`https://<ip-with-dashes>.sslip.io`, a real Let's Encrypt certificate) and a one-time setup token. Open the URL, paste the token, create the admin account and turn on 2FA. Re-running the installer is safe: it repairs the setup, installs the given release, and prints a new token only until setup is done.

| Flag | Effect |
|---|---|
| `--domain panel.example.com` | Use your own domain for the panel (its DNS must point at the server) |
| `--yes` | Answer yes to prompts; with an SSH key present, this turns off SSH password login |
| `--no-harden-ssh` | Leave SSH settings alone |
| `--internal-tls` | Caddy's local CA instead of Let's Encrypt (test boxes without a public IP) |

### What's on the box

| Where | What |
|---|---|
| `/opt/layer/releases/<version>/`, `/opt/layer/current` | The panel, agent and CLI. Read-only, root-owned. The last 3 releases are kept |
| `/opt/layer/node/<version>/` | Node runtimes (checksum-verified official builds), shared by all apps |
| `/srv/apps/<app>/` | Each app's releases and `data/`, owned by its own Linux user `app-<app>` |
| `/etc/layer/apps/<app>/` | Each app's env files (root-only `app.env`, plus `blue.env` / `green.env` with its ports) |
| `/etc/systemd/system/app-<app>@.service` | Each app's sandboxed unit; instances `blue` and `green` |
| `/etc/caddy/sites/<app>.caddy` | Each app's Caddy site; `_panel.caddy` is the panel |
| `/var/lib/layer/panel.db` | Panel state (SQLite, owned by the `layer` user) |
| `/var/log/layer/audit.jsonl` | Every privileged action, root-only |

On the server, `layer ps`, `layer status <app>`, `layer logs <app> -f` and `layer info` show what the panel shows. Underneath they are `systemctl` and `journalctl` on `app-<app>@*`.

### Remove the panel (your apps keep running)

Apps are plain systemd units and Caddy files, so they don't need the panel. To remove only the panel and agent:

```sh
systemctl disable --now layer-panel layer-agent
rm /etc/systemd/system/layer-panel.service /etc/systemd/system/layer-agent.service
rm /etc/caddy/sites/_panel.caddy /usr/local/bin/layer
systemctl daemon-reload && systemctl reload caddy
```

Keep `/opt/layer/node/` (the apps' units run Node from there), `/srv/apps/`, `/etc/layer/apps/`, `/etc/caddy/sites/` and the `app-*` units. Optionally delete the panel's own files afterwards: `/opt/layer/releases`, `/opt/layer/current`, `/var/lib/layer` and `/etc/layer/secret.key`.

## Develop

Needs Node 24 (`.nvmrc`) and yarn 1. TypeScript runs directly through Node's type stripping, with no build step in development.

```sh
yarn install
yarn test          # vitest
yarn typecheck     # tsc, no emit
yarn build:installer   # → dist/install.sh (single file)
bash scripts/build-release.sh   # → dist/layer-<version>.tar.gz
```

| Path | What |
|---|---|
| `installer/` | `install.sh` plus `lib/*.sh`, bundled into one file by `scripts/build-installer.sh` |
| `agent/` | Root helper: allowlisted actions over a unix socket, templates for units and Caddy files |
| `packages/protocol/` | Action allowlist, validators and the agent client, shared by agent, CLI and panel |
| `packages/cli/` | The `layer` command: `ps`, `status`, `logs -f`, `score`, `info`, `call` |
| `panel/` | Next.js panel (runs as `layer`, unix socket only). `LAYER_FAKE_AGENT=1 yarn --cwd panel dev` for UI work on a Mac |
| `system/` | systemd units for the agent and the panel |
| `spike/` | Throwaway experiments to run on a test VPS |

## Test in a local Ubuntu VM

Install [Multipass](https://canonical.com/multipass) with `brew install --cask multipass`. Then:

```sh
scripts/dev-vm.sh up        # Ubuntu 24.04 VM, 2 CPU / 2GB RAM like a small VPS
scripts/dev-vm.sh release   # build the release tarball and run the real installer with it
scripts/dev-vm.sh ui        # Chrome tour of the VM's panel: setup, 2FA, sign in (dist/screenshots)
scripts/dev-vm.sh verify    # check the server state the installer promises
scripts/dev-vm.sh e2e       # agent and blue/green end-to-end tests
scripts/dev-vm.sh lint      # shellcheck every script inside the VM
scripts/dev-vm.sh spike     # the Day 1 sandbox spike
scripts/dev-vm.sh reset     # start again from a fresh box
```

Use `LAYER_VM_IMAGE=26.04` to test the other Ubuntu release. The VM has no public IP, so anything that needs real Let's Encrypt certificates still needs a real VPS.

## Day 1 spike: Next.js inside the sandbox

On a throwaway Ubuntu 24.04/26.04 box (or use `scripts/dev-vm.sh spike`):

```sh
node agent/scripts/render-unit.ts --slug hello --node 24.13.1 --write .next/cache \
  -- node node_modules/next/dist/bin/next start -H 127.0.0.1 > /tmp/app-hello@.service
scp spike/next-sandbox.sh /tmp/app-hello@.service root@<box>:
ssh root@<box> bash next-sandbox.sh app-hello@.service
ssh root@<box> bash next-sandbox.sh --cleanup
```
