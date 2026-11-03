# Servers: one panel, many servers (asked 2026-11-02)

> The panel you have runs your apps on its own server. **Servers** lets the same panel deploy to other servers too: add a VPS, then pick it for a new project, site or integration. Each server keeps its own apps, databases, Caddy, certificates, firewall and backups. The panel shows them all in one place. CLAUDE.md planned this as "a transport swap, not a rewrite": the panel already talks to its agent through one function over one socket, and the agent's actions don't change.

## How it works

1. **Settings → Servers → Add server:** a name and the new VPS's address. The panel shows **one command** to run there as root. It downloads this panel's own version of the installer and release (from the release feed, checked against their sha256), and runs it in **agent-only** mode with the panel's public key.
2. **Agent-only** installs everything a server needs to run apps (Node, Caddy, the agent, the firewall, fail2ban, swap, SSH hardening), but no panel. It makes a user, `layer-link`, whose SSH key is locked to one thing: `restrict,command="socat STDIO UNIX-CONNECT:/run/layer/agent.sock"`. No shell, no forwarding, no other command.
3. **The panel reaches the agent over SSH as `layer-link`.** The forced command turns the SSH session into a pipe to the agent's socket, so the agent's protocol is unchanged.
   - One multiplexed connection per server (`ControlMaster`, kept 10 minutes), so calls after the first don't pay for a handshake.
   - The server's host key is pinned the first time and checked every time after that.
4. **Check connection** on the Servers page calls `system.info` there and shows the server's OS, CPU, memory and disk. The server is ready.
5. **Every project, site and integration belongs to a server** (`server_id`; empty means the panel's own). Every agent call for it goes to its server. The deploy pipeline, domains, env, crons, files, databases, backups, logs, metrics and the database viewer all go through `agentFor(project)`.

## Decisions

1. **The panel never holds root on another server.** `layer-link` can only reach the agent's socket, so a compromised panel can do there exactly what it can do here: the agent's allowlisted actions, nothing else. No root SSH key is stored anywhere. (`PermitRootLogin` stays as the installer leaves it, for you.)
2. **The same version everywhere.** A server runs the agent of the panel's own release. Updating the panel offers to update every server, and a server on another version is flagged. The protocol between them is the same either way.
3. **What's per server:**
   - its public IP and free app addresses (`<app>.<its ip>.sslip.io`, or its own apps domain);
   - Caddy and certificates;
   - MariaDB, Postgres, MongoDB, Redis, PHP and MySQL 8, each installed on the server that needs it;
   - the firewall and fail2ban;
   - swap.
   The Domains page shows the IP of the project's own server for DNS.
4. **What stays in one place:** the panel, its database, GitHub, env vars (encrypted in the panel), alerts, backups' bucket and schedule, Activity (each server keeps its own audit log, and Activity reads them all).
5. **A server that doesn't answer** is shown as offline, its apps keep running (they don't need the panel), and an alert opens. Deploys to it fail clearly instead of hanging.
6. **Not in v1:** moving the panel itself to another server, servers behind NAT (the panel must reach the server's SSH port), and apps spread across servers behind one domain (load balancing).

## Days

1. **The link:**
   - the installer's `--agent-only` and `--panel-key`;
   - the `layer-link` user and its forced command;
   - the panel's SSH key, made once;
   - `callAgent` over an SSH child process;
   - a `servers` table;
   - Settings → Servers (add a server, its install command, Check connection, remove);
   - an e2e between two VMs: a call works, and any other command over that key is refused.
2. **Routing:**
   - `projects.server_id`;
   - `agentFor(project)` everywhere a project's agent is called;
   - free addresses per server;
   - New project, New site and Integrations' Install pick a server;
   - a deploy to the second VM end to end (a GitHub app, a static site, a WordPress site).
3. **Watching:**
   - the monitor samples every server (CPU, memory, disk, apps);
   - Health picks a server;
   - offline servers and their alert;
   - backups and restore on any server;
   - Activity from every server.
4. **The pages:**
   - a server column and filter on Projects and Sites;
   - the server on each project's Overview;
   - the Firewall and Databases pages per server;
   - the sidebar's server switch;
   - update every server from the update dialog.
5. **Moving an app between servers:**
   - a snapshot on one server, restored on the other (databases included);
   - the app deployed there;
   - its domains switched once DNS points at the new IP;
   - then the old copy deleted.

## Risks

- **SSH from the panel's sandbox:** the panel's unit must be able to run `ssh` to port 22 of the servers. Its own folder holds the key (`/var/lib/layer/ssh`, `0700`).
- **A server's sslip.io addresses need its own IP.** Its Caddy gets certificates as the panel's does.
- **Latency:** a deploy makes many agent calls, which `ControlMaster` keeps cheap.
