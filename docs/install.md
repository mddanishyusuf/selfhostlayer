# Install

One command turns a fresh server into a place to deploy your apps, with the panel running on that same server. This page covers what you need, what the installer changes, and how to update, repair or remove it.

## What you need
- A fresh server with Ubuntu 24.04, Ubuntu 26.04 or Debian 12, x86_64 or arm64. 1GB of RAM works; 2GB is more comfortable for Next.js builds.
- 10GB of free disk.
- Ports 80 and 443 free and reachable from the internet, so certificates can be issued.
- Root over SSH, ideally with an SSH key.

## Install

```sh
curl -fsSL https://get.selfhostlayer.com | bash
```

While the project is private there's no public download yet. Build the release on your machine and copy it over instead, as the [README](../README.md#install-on-a-server) shows.

The installer ends with a box showing two things: the panel's address, `https://<your-ip-with-dashes>.sslip.io`, and a one-time setup token. Then:

1. Open the address and paste the token.
2. Create your account.
3. Turn on two-factor sign-in with an authenticator app.
4. Save the recovery codes it shows. Each one signs you in once without your phone.

The panel only answers over HTTPS, and only to the token holder until setup is done.

Running the installer again is safe. It checks and repairs everything, keeps your settings (panel address, apps domain, update feed), and prints a new setup token only until setup is done.

### Options

| Flag | What it does |
|---|---|
| `--domain panel.example.com` | Serve the panel on your own domain; its DNS must already point at the server. You can also move it later from Settings. |
| `--apps-domain apps.example.com` | The base of every app's free address (`<app>.apps.example.com`). It needs a wildcard DNS record (`*.apps.example.com`). Without it, apps get `<app>.<your-ip>.sslip.io`. |
| `--yes` | Answer yes to every question. With an SSH key present, this also turns off password login for SSH. |
| `--no-harden-ssh` | Leave the SSH settings alone. |
| `--internal-tls` | Use Caddy's own certificate authority instead of Let's Encrypt, for test boxes with no public address. Browsers will warn. |
| `--updates-url <url>` | Where one-click updates come from. The default is `https://get.selfhostlayer.com/releases.json`. |
| `--from-tarball <file>` | Install a release file you already have instead of downloading one. |

## What the installer changes

In order:

1. **Checks:** the OS and CPU architecture, that systemd runs the box (containers and WSL aren't supported), free disk, that ports 80 and 443 are free, and the public IP address. If one fails, it stops before changing anything.
2. **Swap:** on servers with less than 4GB of RAM, a 2GB swap file, so a `next build` can't exhaust memory and take the server down.
3. **Packages:**
   - Caddy, from its own apt repository.
   - ufw and fail2ban, watching SSH logins.
   - unattended-upgrades, for security updates.
4. **Node:** official Node.js builds, checked against their published checksums, unpacked read-only in `/opt/layer/node/<version>/`. Each app's unit names the exact version it runs. There's no nvm, fnm or pm2.
5. **Users:** `layer` for the panel, a `layer-apps` group for app users, and a `layer-web` group that lets Caddy reach the panel's socket. Each app gets its own user later, when you create it.
6. **Caddy:** a main config that loads one file per site from `/etc/caddy/sites/`. Its admin API listens on a unix socket, not a port.
7. **The release:** the panel, agent and `layer` command, unpacked read-only in `/opt/layer/releases/<version>/` and linked as `/opt/layer/current`. The last 3 releases are kept.
8. **Secrets:** the key that encrypts env vars and other secrets in the panel's database (`/etc/layer/secret.key`), and the setup token's hash.
9. **Services:**
   - `layer-agent`: runs as root, but only takes a fixed list of actions over a unix socket.
   - `layer-panel`: the web UI, running as `layer`.
10. **The panel's site:** `/etc/caddy/sites/_panel.caddy`, which proxies to the panel's unix socket.
11. **Firewall:** incoming traffic is denied except SSH, 80 and 443 (TCP, plus UDP for HTTP/3).
12. **SSH**, if an SSH key is present and you agree (or pass `--yes`): password login off, root only with a key.

The full log is in `/var/log/layer-install.log`.

## What's on the box

| Where | What |
|---|---|
| `/opt/layer/current`, `/opt/layer/releases/<version>/` | The panel, agent and CLI. Read-only, owned by root. |
| `/opt/layer/node/<version>/` | Node runtimes, shared by all apps. |
| `/srv/apps/<app>/` | Each app's builds (`releases/<sha>/`, `current`) and its `data/` folder, owned by the app's own Linux user `app-<app>`. |
| `/etc/layer/apps/<app>/` | The app's env files: `app.env` (your variables), `services.env` (database URLs), `blue.env` and `green.env` (ports). All root-only. |
| `/etc/systemd/system/app-<app>@.service` | The app's sandboxed unit, with instances `blue` and `green`. Cron jobs are `app-<app>-cron-<name>.timer` units; Redis is `layer-redis-<app>.service`. |
| `/etc/caddy/sites/<app>.caddy` | The app's Caddy site. `_panel.caddy` is the panel. |
| `/var/log/caddy/<app>.log` | The app's access log (JSON). |
| `/etc/layer/config.json` | The server's settings: panel address, apps domain, who can open the panel, update feed. |
| `/var/lib/layer/panel.db` | The panel's database (SQLite, owned by `layer`). |
| `/var/log/layer/audit.jsonl` | Every change the agent made. Root-only. |
| `/var/lib/layer-agent/archive/` | Final dumps and data folders kept when you remove a database or delete an app. Root-only. |

## Update

The panel checks the update feed every 6 hours. When a newer release is out, **Update available** shows at the bottom of the sidebar: click it to read what's new and update. **Settings → Version** checks now and turns the automatic checks off. On the server:

```sh
layer update            # the newest release, if it's newer than yours
layer update 0.2.0      # a specific one, also an older one to go back
```

The agent downloads the release and its installer from the update feed (`https://get.selfhostlayer.com/releases.json` unless the installer was given `--updates-url`) and checks both against the checksums the feed lists. Then it runs the installer in its own systemd unit (`layer-update.service`). Your apps keep running: only the panel and the agent restart. The installer keeps the server's settings as they are.

## Repair

If someone edits or deletes a generated file by hand, Settings → Repair (or `layer repair`) puts it back and restarts what it feeds. That covers app units, cron and Redis units, Caddy sites and env files. The agent remembers what it wrote to each one, so repair only touches files that changed. The installer's own files are left to a re-run of the installer.

## Remove the panel (your apps keep running)

Apps are plain systemd units and Caddy sites, so they don't need the panel. To remove only the panel and the agent:

```sh
systemctl disable --now layer-panel layer-agent
rm /etc/systemd/system/layer-panel.service /etc/systemd/system/layer-agent.service
rm /etc/caddy/sites/_panel.caddy /usr/local/bin/layer
systemctl daemon-reload && systemctl reload caddy
```

Keep these, because your apps use them:

- `/opt/layer/node/` (the app units run Node from there)
- `/srv/apps/` and `/etc/layer/apps/`
- `/etc/caddy/sites/`
- the `app-*` units

Afterwards you can delete the panel's own files: `/opt/layer/releases`, `/opt/layer/current`, `/var/lib/layer` and `/etc/layer/secret.key`.
