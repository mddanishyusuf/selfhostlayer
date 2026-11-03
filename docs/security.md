# Security model

**Who it's for:** one owner hosting their own projects on their own server. There are no strangers' apps on the box. The danger it guards against is one of your apps getting compromised, through a bad npm package or a bug in the app, and spreading from there to your other apps, the panel or the whole server.

**How, without Docker:** Docker's isolation is Linux kernel features (namespaces, cgroups, seccomp). systemd uses the same features directly, so every app gets them without images or a daemon.

## Each app is fenced in

**Its own Linux user.** Every app runs as `app-<app>`: no password, no shell, no SSH login. Its folder (`/srv/apps/<app>`) belongs to that user and nobody else can read it. Builds run as that user too, inside the same kind of sandbox, so a malicious `postinstall` script is contained the same way the app is.

**A sandboxed systemd unit.** Each app's unit (`/etc/systemd/system/app-<app>@.service`) turns on:

| Setting | Effect |
|---|---|
| `ProtectSystem=strict`, `ReadWritePaths=` | The whole filesystem is read-only except the app's `data/` folder and the caches its framework needs (like Next.js's `.next/cache`). |
| `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes` | No home folders, its own `/tmp`, no devices. |
| `ProtectProc=invisible` | It can't see other processes. |
| `NoNewPrivileges=yes`, `CapabilityBoundingSet=` (empty), `RestrictSUIDSGID=yes` | It can never gain privileges, even through a setuid binary. |
| `SystemCallFilter=@system-service ~@privileged @resources` | Only the system calls a normal service needs. |
| `RestrictNamespaces=yes`, `ProtectKernel*=yes`, `ProtectClock=yes` and others | No new namespaces, no kernel tunables, modules or logs, no clock changes. |
| `MemoryMax=`, `CPUQuota=`, `TasksMax=` | One runaway app can't freeze the server; it restarts at its memory limit. |

`MemoryDenyWriteExecute` stays off on purpose: Node's JIT needs it.

`layer score <app>` shows systemd's own security rating for the unit (0 is the safest, 10 the least). A plain service scores around 9.6; app units score around 1.3.

**Its own credentials.**

- Postgres: its own role and database, owned by it and closed to every other role.
- MySQL: its own user, limited to its own database and to logins from 127.0.0.1.
- MongoDB: its own user, kept in its own database, with access to that database only. MongoDB requires a login for everything and listens on 127.0.0.1 only. The agent has its own MongoDB login (`/var/lib/layer-agent/mongodb-admin.json`, root only) to create and drop app users.
- Redis: its own Redis process, with its own password and memory cap.

No two apps share a password.

The panel's database viewer works inside these walls. Each page it shows is a short sandboxed job running as the app's own user with the app's own logins, so it can't see another app's data, and every engine is opened read-only: SQLite read-only with `query_only`, Postgres with `default_transaction_read_only` and a 5-second statement limit, MySQL in a read-only session, MongoDB with `find` alone (no server-side JavaScript), Redis with read commands alone. A query is one statement: a `;` in the middle is refused before anything runs.

Editing rows (SQLite, Postgres and MySQL tables) is a separate action, `db.update`, run the same way: a sandboxed job as the app's own user with the app's own logins, so an edit can't reach anything the app itself can't. The visual builder's filters and the new values never become SQL syntax: columns are checked against the table and quoted, values are bound parameters (SQLite) or escaped literals (Postgres, MySQL), and operators come from a fixed list. Each edit is one transaction that writes only if exactly the number of rows the user confirmed still match. The panel backs the app up to your bucket first, and the agent's audit log records the table, the columns and how many rows, never the values.

**Secrets it can read but not change.** Env vars are encrypted in the panel's database (AES-256-GCM). On disk they exist only as `/etc/layer/apps/<app>/app.env`, owned by root and readable by nobody else. systemd reads that file and hands the variables to the app's process, so the app gets its env but has no file it could rewrite. Values never appear in build logs.

## The network

- Apps listen on 127.0.0.1 only. Caddy is the only thing listening publicly, on 80 and 443.
- ufw denies everything else incoming except SSH. fail2ban bans addresses that keep failing SSH logins.
- Caddy's admin API and the panel listen on unix sockets, not on localhost ports a compromised app could reach.

## The panel and the agent

The panel is the most valuable target, so it holds no privileges of its own.

- **Two processes:**
  - The web UI (`layer-panel`) runs as the unprivileged user `layer`.
  - The agent (`layer-agent`) runs as root, but takes only a fixed list of actions over a unix socket that only the panel's user can open. Examples: create an app's user, write its unit, start it, route a domain, run a build as the app's user. There's no "run this command" action, and every parameter is validated.
- **Signing in:**
  - A one-time setup token for the first visit.
  - Password plus a code from an authenticator app on every sign-in, with recovery codes for a lost phone.
  - Five failed attempts lock out that address and that account for 15 minutes.
- **Restricting who can reach it:** Settings → Access can limit the panel to some addresses or to Tailscale. Blocked requests stop at Caddy and never reach the panel. If you lock yourself out, `layer access reset` on the server undoes it.
- **A record of every change:** the agent writes every change it makes to `/var/log/layer/audit.jsonl` (root-only). Server → Activity shows it.
- **Updates and integrations are checked:** the agent downloads them only from the addresses in `/etc/layer/config.json` (the release feed, and the catalog beside it), never from an address the panel names. It checks each file against its sha256 before using it. An integration is unpacked by its own app user with no network access, then runs fenced in like your apps.

## The server

The installer turns on:

- unattended security upgrades
- fail2ban for SSH
- a firewall
- swap on small servers

If an SSH key is present and you agree, it also turns off SSH password logins.

## Backups

Backups are encrypted on the server before they leave it, with AES-256-GCM and a new key for each file, derived from your recovery key. Your storage provider only ever sees ciphertext.

The recovery key is shown once, when you turn backups on. The panel keeps an encrypted copy so scheduled backups can run. If the server is lost, though, the copy you wrote down is the only way to read the backups on a new one.

## Honest limits

- **One kernel.** All apps share the server's kernel. A kernel exploit could escape any sandbox, and that's equally true of Docker. Only separate virtual machines avoid it, which is out of scope for one owner's own apps.
- **Apps can reach each other's ports on 127.0.0.1.** Databases are covered by per-app passwords, but an app's own HTTP port is reachable from the other apps on the box.
- **The panel can decrypt your secrets.** It needs to, to write them for your apps. Someone who takes over the panel gets your env vars too, which is why it runs unprivileged, needs 2FA, and can be locked to your addresses.
- **The agent is root.** It's kept small and only takes listed actions, but a bug in it would matter. It's sandboxed by systemd as far as its work allows.

## Other servers

A panel that deploys to other servers reaches each one's agent over SSH as `layer-link`, with a key locked to one command: a pipe to that agent's socket. There's no shell, no other command and no forwarding. So a compromised panel can do on another server only what it can do on its own: the agent's allowlisted actions. Each server's host key is pinned at the first connection. See [Servers](servers.md).

