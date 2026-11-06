# Servers

One panel can deploy to several servers. Your projects, sites and their databases run on whichever server you pick, and the panel shows them all in one place: Projects, Sites, Health, Firewall, Activity and alerts.

## Add a server

1. Get a fresh VPS: Ubuntu 24.04 or 26.04, or Debian 12, at any host.
2. In the panel, open **Servers → Add a server**. Give it a name and its IP address (and the SSH port if it isn't 22).
3. The panel shows **one command**. Run it on the new server as root. It downloads the same version as your panel, checks it against the release feed's checksums, and installs in **agent-only** mode. That means everything apps need (Node, Caddy, the firewall, fail2ban, swap, SSH hardening), but no second panel.
4. Back in the panel, press **Check connection**. The server's system, memory, disk and free addresses show up. It's ready.

## Use it

- **New project:** pick the server in the tabs at the top.
- **New site:** pick it in the **Server** field.
- **Free addresses:** each server has its own, `<app>.<its IP>.sslip.io`.
- **Domains:** each project's Domains page shows the IP of its own server, for the DNS record.
- **Each server keeps its own** apps, databases (MariaDB, Postgres, MongoDB, Redis, MySQL 8 for Ghost), PHP, Caddy, certificates and firewall. Each one is installed on the server that needs it, the first time it's needed.
- **What stays in one place:** env vars, private files, GitHub and the backup bucket all stay in the panel, and backups of any server go to the same bucket.

## Move a project

On a project's **Settings**, **Server → Move to** moves it to another server, and back:

1. It's made on the other server, with the databases and Redis it has.
2. It's built and started there.
3. Its data (files and databases) is copied from a snapshot of the old server.
4. Its free address moves to the new server's. Its own domains wait until their DNS points at the new IP. The Domains page shows them pending, then live.

The old copy keeps running, so nothing is down while DNS changes. Once the domains are live on the new server, press **Remove the old copy**: it's stopped and removed there, with its data archived on that server.

If the deploy on the new server fails, the project goes back to its old server as it was.

Changes made on the old copy after the snapshot stay there. For a busy app, move it when it's quiet. Sites can't move yet.

## Watching

- **Health and Firewall** have a switch per server.
- **Activity** shows what every server's agent did, each line naming its server.
- **The monitor** asks every server about itself each minute. If one doesn't answer for 3 minutes, an alert opens. Its apps keep running on their own, since they don't need the panel, but deploys to it fail until it answers again. A server's disk raises the same alert as this one's.
- **Updates:** when the panel is updated, **Servers** flags a server running another version and offers **Update to <version>**. That runs the same one-click update there, and the server stays agent-only.

## Security

The panel never holds root on another server. The agent-only install makes a user, `layer-link`. Its SSH key (the panel's) is locked to one thing: a pipe to the agent's socket.

```
restrict,command="/usr/bin/socat STDIO UNIX-CONNECT:/run/layer/agent.sock" ssh-ed25519 … layer-panel
```

- **No shell, no other command, no port forwarding.** A compromised panel can do on another server exactly what it can do on its own: the agent's allowlisted actions, nothing else.
- **The private key stays on the panel's server**, in `/var/lib/layer/ssh/` (only the panel's user can read it).
- **Each server's host key is pinned** the first time the panel connects. If it changes (say you reinstalled the server), the panel refuses to connect until you remove the server and add it again.
- **Root SSH stays as it was**, with keys only, which is how the installer leaves it.

## Remove a server

**Servers → Remove** makes the panel forget it, once no project runs there. Its apps and agent stay on it and keep running.

## On the server

```sh
layer ps                                   # its apps
journalctl -u layer-agent -f               # its agent, as the panel drives it
cat /var/lib/layer-link/.ssh/authorized_keys   # the panel's key, and what it may do
```
