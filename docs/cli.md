# The `layer` command

Everything the panel shows, from an SSH session on the server. `layer` talks to the same agent the panel uses. Each command is a thin wrapper, and the raw `systemctl`, `journalctl` and file paths are listed with it, so you never depend on the tool to see what's going on.

Run it as root (or with `sudo`).

| Command | What it does | Underneath |
|---|---|---|
| `layer ps` | Every app, its live color (blue or green), the state and port of both colors, and its domains. | `systemctl status 'app-*@*'` |
| `layer status <app>` | Both colors of one app: state, build, memory, restarts, since when. | `systemctl status 'app-<app>@*'` |
| `layer logs <app> [-f] [-n 100] [--color blue\|green]` | The app's output; `-f` follows it. | `journalctl -u 'app-<app>@*' -f` |
| `layer score <app> [--color blue\|green]` | systemd's security score for the app's sandbox (0 is the safest, 10 the least). | `systemd-analyze security app-<app>@blue` |
| `layer info` | The server: OS, CPU and load, memory, disk, Node versions, Caddy and the agent. | |
| `layer import <app> <file.tar.gz>` | Replaces the app's `data/` folder with an archive from another server. SQLite files are checked first; the app is stopped and started around the swap; the replaced folder is kept next to it. Given a single SQLite database (`app.db`, gzipped or not), it replaces only that database in `data/`. | |
| `layer access` | Who may open the panel: anyone, or a list of addresses. | `/etc/caddy/sites/_panel.caddy` |
| `layer access reset` | Lets everyone reach the sign-in page again, for when you've locked yourself out. | |
| `layer update [version]` | Updates the panel, agent and CLI from the update feed (without a version: to the newest release, if it's newer) and follows the installer's output. Apps keep running. | `journalctl -u layer-update.service -f` |
| `layer repair` | Puts back generated files that were edited or deleted by hand (units, Caddy sites, env files) and restarts what they feed. | |
| `layer call <action> [json]` | Sends one raw action to the agent and prints the answer, for debugging. | |

## Where things are

```sh
systemctl status 'app-<app>@*'          # the app's two colors
journalctl -u 'app-<app>@*' -f          # its output
cat /etc/caddy/sites/<app>.caddy        # how Caddy routes its domains
ls -la /srv/apps/<app>/                 # its builds (releases/), current, and data/
ls /etc/layer/apps/<app>/               # its env files (root-only)
systemctl list-timers 'app-<app>-cron-*'  # its cron jobs
tail -f /var/log/caddy/<app>.log        # its requests, as JSON
tail /var/log/layer/audit.jsonl         # what the agent changed
```

## Examples

Follow an app's output while you reproduce a bug:

```sh
layer logs piqo -f
```

Bring a data folder from an old server (see [Moving an app from pm2](moving-from-pm2.md)):

```sh
layer import piqo /root/piqo-data.tar.gz
```

Locked out after restricting the panel to an address you no longer have:

```sh
layer access reset
```
