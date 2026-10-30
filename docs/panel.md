# The panel, page by page

What each page does, and what happens on the server when you press its buttons. Nothing here is hidden: every app is a folder, a Linux user, a systemd unit and a Caddy file, and the commands under each section let you see the same thing from SSH.

The sidebar has two modes. Outside a project it lists the server's pages. Inside a project (`/projects/<app>/…`) it lists that project's pages, with "← All projects" at the top.

---

## Projects

All your projects, with their status, last deploy and address. Each project shows the logo of its stack (Next.js, Vite, Astro, Node.js…), in one color for all. Filter by status (All, Live, Building, Failed), search, or switch between the list and a grid of site previews. **New project** is at the top right.

### New project
1. Pick a repository from your GitHub App's installations, or paste a public GitHub URL.
2. Optionally set a root folder, for a project inside a monorepo.
3. The panel reads `package.json` and the lockfile to detect the framework, package manager and commands: Next.js, Vite, Astro, Nuxt, Remix, Express, Fastify, Hono, or plain static files, with npm, pnpm, yarn or bun.
4. **Configure** shows what it found, with every value editable, and your env vars.
5. **Deploy** builds it and puts it live at `https://<app>.<apps domain>`.

Creating the project makes the app's Linux user and folders: `useradd --system --shell /usr/sbin/nologin --home /srv/apps/<app> app-<app>`.

---

## Inside a project

### Overview
- **Stats strip:** status, runtime (Node version, or static files), memory, and the sandbox's security score.
- **Production:**
  - On the left, the image the site offers for link previews (`og:image`), fetched once per deployment. There's no headless browser on the server; sites without one get a card with their title.
  - On the right, its domains, when it was deployed, and the commit.
- **Usage:** CPU and memory for the last 24 hours or 7 days, plus the app's disk size. Every chart has a table view.
- **Redeploy** builds the latest commit of the branch again. Each past deployment has **Roll back to this deployment**.

Underneath, the usage numbers are systemd's own accounting for the app's units:

```sh
systemctl show 'app-<app>@blue' -p CPUUsageNSec -p MemoryCurrent
```

The panel samples them every minute. It keeps 24 hours at that resolution and 7 days as hourly averages.

### Deployments
Every deployment of the project, newest first, with its commit, what started it (a push, you, a rollback, an import), its status and how long it took. A deployment's page streams its build log live.

What one deploy does, step by step:

1. **Fetch:** downloads the commit's tarball from GitHub into `/srv/apps/<app>/releases/<sha>/`. The server never holds git credentials.
2. **Build:** runs the install and build commands as `app-<app>` in a sandbox (`systemd-run` with the same restrictions as the app, plus network access for the package registry). The output streams to the page. One build runs at a time by default; Settings → Builds allows up to 4, never two of the same project. The rest wait in line and start on their own, and a waiting deployment's page says what it's waiting for.

Each app keeps its own package cache (npm, yarn, pnpm, bun) to make builds fast. Apps don't share caches, so one app can't tamper with another's packages. When the disk is under 25% free, a build first empties every app's cache over 256 MB, and its log says what was freed. Builds stop if the disk is under 15% free.
3. **Start:** writes the app's unit and env file, then starts the new build on the idle color (blue or green) and waits for its health check.
4. **Switch:** points the app's Caddy site at the new color, waits for requests in flight, then stops the old color. Visitors never see a gap.

Static sites skip the start step: Caddy serves the build output directly, with no process.

A **rollback** reuses the build already on disk, so it's a restart, not a rebuild. The last few builds are kept.

```sh
systemctl status 'app-<app>@*'
ls -la /srv/apps/<app>/releases/
cat /etc/caddy/sites/<app>.caddy
```

Pushes to the project's branch deploy automatically, through the GitHub App's signed webhook. GitHub shows each commit's deploy status.

### Logs
- **Output:** the app's stdout and stderr from journald, streamed live. It auto-scrolls until you scroll up, keeps ANSI colors, and has copy and download buttons.
- **Requests:** the last 200 requests from Caddy's access log for the app: time, status, method and path, duration, size and client address. Server errors are counted at the top. Static sites only have this tab.

```sh
journalctl -u 'app-<app>@*' -f
tail -f /var/log/caddy/<app>.log
```

### Domains
Add your own domain:

1. The panel shows the A record to create.
2. It checks public DNS through Cloudflare's and Google's resolvers, not the server's own, until the domain points at this server. If something's off, it says what to change: a record pointing elsewhere, Cloudflare's proxy turned on, or an IPv6 record that points somewhere else.
3. Then it adds the domain to the app's Caddy site, and Caddy gets a Let's Encrypt certificate. The page shows the certificate's status.

Adding a domain can also add `www.` in front of it, redirecting to it.

**Behind Cloudflare's proxy (orange cloud).** Public DNS then shows Cloudflare's addresses, not this server's. The domain waits until you choose: set the record to "DNS only", or press **Keep the proxy**. To keep it, set these in Cloudflare:

- **SSL/TLS** to **Full (strict)**.
- **Always Use HTTPS** off. This server redirects to HTTPS itself, and its first certificate needs plain HTTP to reach the server.

The certificate status on the page is this server's own, checked directly, so it stays accurate behind the proxy. Apps and the Requests tab see the visitor's real address: Caddy takes `CF-Connecting-IP` from Cloudflare's published address ranges, and from nowhere else.

The free `<app>.<apps domain>` address keeps working next to your domains. Once one of your own domains is live, its remove button turns it off, and **Add it back** restores it. A project's last live domain can't be removed, so the app always answers somewhere.

```sh
cat /etc/caddy/sites/<app>.caddy
journalctl -u caddy | grep <domain>
```

### Databases
One of each per app. PostgreSQL, MySQL and Redis are installed on the server the first time any app asks for one; MongoDB is installed once, with its own button. Only this app can reach its databases.

- **PostgreSQL:** a role and database (`app_<app>`) on the server's shared PostgreSQL. The app gets `DATABASE_URL`.
- **MySQL:** a user and database (`app_<app>`) on the server's MariaDB, the MySQL that comes with Ubuntu and Debian. The user can only log in over TCP from 127.0.0.1. The app gets `DATABASE_URL` (`mysql://…`). An app gets one SQL database, Postgres or MySQL, since both use that variable.
- **MongoDB:** one MongoDB 9.0 for the whole server, from MongoDB's own repository (it isn't in Ubuntu's or Debian's). Install it once (**Install MongoDB on this server**, on a project's Databases page or under Databases); then each project's **Create database and user** gives it a database and a user (`app_<app>`) with its own password, which can read, write and manage that database and no other. The page shows the host, database, username and password (hidden, with Reveal and Copy) and the whole `MONGODB_URI`, which the app gets too, so it fits next to Postgres or MySQL. MongoDB listens on 127.0.0.1 only; to open a database in Compass or mongosh on your computer, tunnel the port first (`ssh -N -L 27017:127.0.0.1:27017 root@<server>`) and use the same URI. It runs on Ubuntu 24.04 and 26.04, and on Debian only on x86: MongoDB has no ARM packages for Debian. MongoDB 9.0 refuses to start on Linux 6.19.0 to 7.0.13, which includes every Ubuntu 26.04 kernel, when its memory allocator uses per-CPU caches, so it runs with per-thread caches on every server (as MongoDB did up to 7.0; the setting is in `systemctl cat mongod`). If MongoDB ever doesn't start, the install tells you why, from MongoDB's log, and stops it instead of letting it retry every few seconds.
- **Redis:** a small Redis of its own: its own port, password and memory cap, running as the app's user, with its data in `data/redis`. The app gets `REDIS_URL`.
- **SQLite:** nothing to install. Keep database files in `DATA_DIR` (`/srv/apps/<app>/data`), and backups find them by their header and copy them safely.

Adding or removing a database restarts the app on the same build, with zero downtime, so it gets the new URL. Removing one asks you to type the app's name. Unless you say otherwise, it keeps a final dump in `/var/lib/layer-agent/archive/`.

**Browse data** (next to each database, and **Browse SQLite databases** for the files in `DATA_DIR`) opens a read-only viewer: the tables, collections or keys on the left, a page of rows on the right. The sidebar shrinks to its icons there, to give the rows the width; the button at its bottom opens the whole menu. Click a column to sort by it, a row to see every value whole (JSON indented). Above the rows:

- **SQL** (SQLite, PostgreSQL, MySQL): run a query. One statement, without `;` (also not inside quotes), up to 500 rows and 5 seconds.
- **MongoDB:** filter a collection with JSON, like `{"status": "active"}` or `{"_id": {"$oid": "…"}}`. Filters that run JavaScript (`$where`, `$function`) are refused.
- **Redis:** narrow the keys with a pattern, like `session:*`. A key shows its value: a string, a hash's fields, a list or a sorted set page by page, and when it expires.

The viewer reads with the app's own login, as the app's own user, so it sees exactly what the app can. Nothing it runs can write: SQLite is opened read-only, Postgres and MySQL in read-only transactions, MongoDB only finds, and Redis only reads. Values longer than 2,000 characters are cut, with their full length shown.

```sh
sudo -u postgres psql -c '\l'          # Postgres databases
mariadb -e 'SHOW DATABASES'            # MySQL databases
systemctl status mongod                # MongoDB (settings in /etc/mongodb-layer.conf)
systemctl status layer-redis-<app>     # the app's Redis
```

### Backups
**Back up now** takes a snapshot of the app's data folder:

1. Every SQLite file is copied with SQLite's online backup API, safe while the app writes, and the copy must pass `PRAGMA integrity_check`.
2. Postgres, MySQL and MongoDB are dumped with the app's own login.
3. The archive is encrypted on the server and uploaded to your bucket (set up under Server → Backups).

**Restore** puts a backup back:

1. It unpacks the backup next to `data/` first, so a broken backup changes nothing.
2. It stops the app, swaps the folders and loads the database dump.
3. It starts the app again.

The replaced data stays next to it as `data.before-restore-<time>`. For MySQL and MongoDB, that folder also holds a dump of the database as it was.

**Import** brings a data folder from another server. It goes through the same checks as a restore. See [Moving an app from pm2](moving-from-pm2.md).

### Cron jobs
Commands on a schedule, run as the app's user with its env vars, in its sandbox. Each job is a systemd timer:

```sh
systemctl list-timers 'app-<app>-cron-*'
journalctl -u 'app-<app>-cron-<name>'
```

**Run now** starts it at once. The job's page lists its recent runs with their output and exit codes. A failing job raises an alert.

### Environment
Your variables, encrypted in the panel's database. On deploy they're written to `/etc/layer/apps/<app>/app.env` (root-only), which systemd hands to the app's process. **Save and restart** loads changes without a rebuild and without downtime. Variables read at build time, like `NEXT_PUBLIC_*`, need a redeploy.

Edit them as rows, or switch to **Raw .env** to see them all as one `.env` file. Paste a whole file there; switching back to **Rows** turns each `KEY=value` line into a row, and lines that aren't `KEY=value` are pointed out before they're left out. Values stay hidden until you click **Show values**, and the browser never fills them in with a saved password.

**Set for you** lists what the server provides:

- `DATA_DIR`: the folder that survives deploys.
- `PORT` and `HOST`: 127.0.0.1 and the live color's port.
- `DATABASE_URL` and `REDIS_URL`: when you add a database.

### Settings
- **Source:** the repository and branch.
- **Build:** install and build commands, root folder, Node version (installed on the server if needed).
- **Run:** a Node server or static files, the start command, the health check path, writable folders, the output folder.
- **Resources:** the memory limit; the app restarts if it goes over.
- **Delete project:** type the app's name to confirm. It stops the app and removes its user, files, unit, Caddy site and databases. Its `data/` folder and final database dumps are kept in `/var/lib/layer-agent/archive/` unless you say otherwise.

### Visit site
Opens the app's live address.

---

## Server pages

### Deployments
Every project's deployments in one list. A gold dot on the sidebar item means something is building.

### Analytics
Coming soon.

### Firewall
The firewall rules (`ufw status`) and fail2ban's SSH jail: who is banned now, and failures so far. Editing rules from the panel is coming.

```sh
ufw status verbose
fail2ban-client status sshd
```

### Domains
Every project's domains, one row per project: its main domain, the project's name and how many more it has, or what needs attention. **Manage** opens that project's Domains page.

### Integrations
Coming soon: one-click apps built for Self Host Layer (analytics, email, scheduling and more).

### Databases
- **Engines:** SQLite, PostgreSQL, Redis, MongoDB and MySQL (MariaDB), each with its version, whether it runs (PostgreSQL, MySQL and MongoDB as systemd sees their server) and how much the apps use. MongoDB has its Install button here, and Start when it's stopped, which tells you why if it can't start.
- **Every app's databases:** one list across all apps, with each database's size and its tables, collections or keys. SQLite files are found in each app's data folder by their header. **Browse** opens the read-only viewer (see a project's [Databases](#databases)); the **…** menu copies the connection URL or opens the app's Databases page. A database that doesn't answer says so.
- **Add a database:** pick an engine and the app it's for. An app gets one SQL database (PostgreSQL or MySQL), and engines that aren't installed yet install first, in about a minute.

### Health
The server itself: CPU, memory, disk and swap right now, CPU and memory charted over the last 24 hours or 7 days, each app's memory against its limit with its CPU and whether it runs, and the versions of Caddy, the agent, the panel and Node. The server's name at the top of the sidebar opens it too.

### Backups
- **Storage:** any S3-compatible bucket: AWS S3, Cloudflare R2, Backblaze B2, MinIO, and others. Connecting tests it: the panel writes, reads, lists and deletes a test object.
- **Recovery key:** shown once. Write it down. Backups are encrypted with it before they leave the server, and it's the only way to read them on a new server.
- **Schedule:** a daily backup of every app at the hour you pick, keeping as many as you choose.
- **Back up everything:** every app, plus the panel's own database and key, so a new server can be restored from scratch.
- **The list:** every backup with what it holds (SQLite files checked, a Postgres, MySQL or MongoDB dump) and its size.

### Alerts
Where alerts go: Telegram, Discord, a webhook (signed) or email over SMTP. Each channel has a test button. You get alerts for:

- a failed deploy
- a crash-looping app (3 restarts in a minute, or systemd giving up)
- disk over 80%
- certificate problems
- failed cron jobs
- an app without a backup for over a day

Each alert says when it's resolved. Open incidents are listed, and a gold dot on the sidebar item means one is open.

### Activity
Every change the agent made to the server, in words, newest first: what it did, which app it was about, the result, how long it took and when. A change that failed says why, in the same words the panel showed when it happened. Reads aren't listed, only changes.

```sh
tail -f /var/log/layer/audit.jsonl
```

### Settings
- **Panel address:** move the panel to a domain you own. Point the name at the server first. The panel checks public DNS, waits until the certificate is issued, then switches; the old address redirects to the new one.
- **Apps domain:** the base of every app's free address. Your own domain needs one wildcard record (`*.apps.example.com`). The old addresses keep redirecting.
- **Access:** who can reach the panel at all: anyone (password plus 2FA), only some addresses (yours is filled in), or Tailscale only. Blocked requests stop at Caddy. GitHub's webhook always gets through. A list that would lock you out is refused, and `layer access reset` on the server undoes any list.
- **Builds:** how many projects can build at the same time (1 to 4). A build can use twice its app's memory limit, so on small servers one at a time is safest.
- **GitHub:** the GitHub App this server created under your account. Its private key never leaves the server. Install it on more repositories from here.
- **Account:**
  - Change your password; that signs out every other session.
  - Make new recovery codes; the old ones stop working.
  - See where you're signed in, and sign out the others.
- **Version:** the panel, agent and server versions, with Check for updates and the switch for the automatic checks (every 6 hours). A newer release also shows as **Update available** at the bottom of the sidebar. Updating keeps your apps running. The same as `layer update`.
- **Repair:** put back generated files edited or deleted by hand. The same as `layer repair`.
- **Remove the panel:** how to remove only the panel; your apps keep running. See [Install](install.md#remove-the-panel-your-apps-keep-running).
