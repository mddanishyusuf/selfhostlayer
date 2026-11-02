# Sites: one-click WordPress and Ghost, as many as the box holds (asked 2026-11-02)

> The fifth integration, and the first built from other people's software: **WordPress** and **Ghost**, installed and kept the way we keep our own apps. **Sites → New site → WordPress or Ghost, a title and an address → a live HTTPS site with its admin login, in under a minute.** Each site is its own project: its own Linux user, sandbox, memory limit, database, domain, backups and logs. No Docker, and no process shared between sites.

## Why it fits

- **The pitch gets bigger:** "10 WordPress sites on a $5 box, each one sandboxed." Shared hosts give you that without the isolation. Docker panels give you isolation at 150 MB+ per site. With PHP-FPM's `ondemand` mode an idle WordPress costs about one master process (~12 MB), and MariaDB is shared and already there.
- **People ask for it first.** WordPress is the most common reason anyone rents a VPS and installs a panel. Ghost is the blog indie makers pick, and it's Node, our home ground.
- **Most of the plumbing exists:**
  - per-app users, systemd sandboxes and memory limits;
  - MariaDB with a user and database per app (`mysql.add`), dumped into backups;
  - Caddy sites with automatic certificates, and domains with DNS checks;
  - cron jobs as timers, backups and restore, import, logs, alerts.

## Decisions for both

1. **Name: Sites** (decided 2026-11-02). The sidebar item, the area (`/sites`) and the catalog entry are called Sites. A site's engine is named for what it is ("WordPress 6.8", "Ghost 6.73"): saying what we install is allowed by both trademark policies. Neither name goes into our product's own name.
2. **A site is a project** with `source: "site"` and `engine: "wordpress" | "ghost"`. It gets the project pages: Domains, Logs, Backups, Cron jobs and Settings, plus an engine page. Projects doesn't list sites (as with integrations), and Databases shows their databases.
3. **The admin account is made at install, never left open.** WordPress's installer and Ghost's `/ghost` setup both let *the first visitor* create the owner. We create it in the same step as the install, with a random password the panel shows **once** (with Copy). There's no window where a stranger could claim the site.
4. **Downloads are checked:**
   - WordPress from wordpress.org: the `.tar.gz` and its `.sha1`;
   - Ghost from the npm registry: the tarball and its sha512 `integrity`;
   - both over HTTPS, cached in `/var/cache/layer/sites/`;
   - wp-cli is a phar with a pinned version and sha512, shipped with the agent;
   - **Trust:** each checksum comes from the same host as its file, like our catalog and both projects' own updaters. That's an honest limit, written down.
5. **The site lives in `data/`**, so backups, restore, import and the server-move assistant work unchanged, database dumps included. WordPress core adds about 25 MB to each backup; Ghost's code is rebuilt, not backed up (6).
6. **Mail:** both engines send through the **Email** integration when it's installed (a key the panel makes, as Forms does), or through the panel's SMTP settings. Without either, the engine page says sign-in and password emails won't arrive.
7. **Many sites means many installs.** No WordPress Multisite and no shared Ghost: each site is separate, so one bad plugin or theme can't touch the others.

## WordPress

1. **A new runtime, `php`, used by Sites only for now** (decided 2026-11-02). It widens decision 3 of 2026-10-28 ("Node + static only") for WordPress. PHP for GitHub projects (Laravel and the like) can come later on the same runtime.
2. **PHP from the distro, installed once** (the first WordPress site does it, or a button on Sites):
   - `php-fpm` and the extensions WordPress wants: mysql, curl, gd, imagick, intl, mbstring, xml, zip, opcache;
   - versions: Ubuntu 24.04 ships PHP 8.3 and Debian 12 ships 8.2; 26.04's version is checked on Day 1;
   - the distro's own `php-fpm` service is disabled: nothing runs PHP until a site does.
3. **One PHP-FPM master per site,** as a sandboxed unit `app-<slug>@php.service`:
   - it runs as `app-<slug>`, with the same sandbox and `MemoryMax=` as our Node apps;
   - `pm = ondemand` (0 workers when idle, at most 5, idle ones gone after 30 s);
   - `open_basedir` to the site and its tmp folder;
   - it listens on a unix socket, `/run/layer/php/<slug>.sock` (`app-<slug>:caddy`, 660). Only Caddy can reach it: other apps can't connect, unlike a localhost port.
   - There's no blue/green: WordPress changes itself in place, so a restart is enough.
4. **Files:** the site sits at `/srv/apps/<slug>/data/wordpress`, owned by the site's user.
   - Folders are `2750 app-<slug>:caddy` (setgid) and the umask is 027, so Caddy can serve the static files WordPress writes but can't change them.
   - `wp-config.php` is 600, so only PHP reads it.
5. **Caddy:**
   - `php_fastcgi` to the socket, with static files served directly;
   - **blocked:** `wp-config.php` and dotfiles, PHP under `wp-content/uploads`, `xmlrpc.php` (a setting allows it), and the readme and license files.
6. **Updates and plugins:** WordPress can update itself and install plugins (`FS_METHOD direct`), because that's what its users expect. Plugins are code that runs with the site's rights, and only the site's.
   - `DISALLOW_FILE_EDIT` is always on (no code editor in wp-admin).
   - **Lock code** (`DISALLOW_FILE_MODS`) is a setting for sites that are done.
   - Updates run from the panel are backed up first.
7. **Install, `site.create` with engine wordpress,** reusing `app.create` and `mysql.add`, then as the site's user in a sandbox:
   - it unpacks core;
   - it writes `wp-config.php`: fresh salts, the database, `WP_HOME` and `WP_SITEURL`, HTTPS behind Caddy, `DISABLE_WP_CRON`, and a must-use plugin for mail (Decisions 6);
   - it runs `wp core install` with the owner from Decisions 3.
8. **WP-Cron runs from a timer** every 5 minutes (`wp cron event run --due-now`, a cron job of the site), so visits never wait for it.
9. **Logins:** a fail2ban jail on Caddy's access log for repeated `POST /wp-login.php` (10 in 10 minutes bans for an hour). Optionally, wp-admin can be limited to the panel's allowed addresses.

## Ghost

1. **Ghost runs on our Node runtime**, as an app we install rather than build:
   - the `ghost` npm package (6.73 today; needs Node 22 or 24, and we ship 24), unpacked into a release as the site's user;
   - its dependencies installed with npm, offline after the first fetch, through the npm cache;
   - started as `node current/index.js` under the usual blue/green unit, with the health check on `/ghost/api/admin/site/`.
   - Ghost's code isn't backed up, since it can be fetched again. Its content (`content/` with images, themes and the database) lives in `data/`.
2. **Its database is MySQL 8, the only one Ghost supports in production** (decided 2026-11-02: only what Ghost supports, so updates don't break). Not MariaDB, which is what our MySQL is, and not SQLite, which Ghost calls development-only.
   - **One MySQL 8 server for all Ghost sites,** installed by the first Ghost site, with a user and database per site, as MariaDB has.
   - **Installed from Oracle's own tarball** ("Linux – Generic", x86_64 or aarch64), not apt: Ubuntu's `mysql-server` and `mariadb-server` packages conflict, so the two can't both come from apt.
     - The tarball is checked against its GPG signature, with Oracle's key shipped with the agent (as MongoDB's is).
     - It's unpacked into read-only `/opt/layer/mysql/<version>/`, like Node.
   - It runs as its own sandboxed unit, `layer-mysql8.service`, under user `mysql8`:
     - data in `/var/lib/layer-mysql8`;
     - port 3307 on 127.0.0.1;
     - the buffer pool sized for a small box (128 MB);
     - logs to the journal.
   - The LTS line is pinned (8.4); patch updates come through `layer update` with the agent.
   - **Backups** take each site's `mysqldump`, and restore loads it back (saving the database as it was first, as for MariaDB).
   - About 350–450 MB idle, said on New site the first time.
3. **Config:** `config.production.json` is written by the agent: the `url`, the database, `content` in `data/`, mail (Decisions 6), and listening on 127.0.0.1 and the live color's port. A domain change rewrites the `url` and restarts the site.
4. **The owner is made at install** through Ghost's own setup API, the moment it first answers on 127.0.0.1 and before Caddy serves it (Decisions 3).
5. **Updates:** the engine page offers a newer Ghost from npm (minor versions; a new major is announced with its notes). Updating means a backup first, then fetching and installing the new version into a new release, then **stop, start** rather than blue/green. Ghost migrates its database when it starts, and two versions mustn't share one database.
6. **Newsletters:** Ghost sends bulk email only through Mailgun, which is its own setting in Ghost's admin. The engine page says so, and links there.
7. **Memory:** a Ghost site takes about 150–250 MB, far more than an idle WordPress. The default limit is 512 MB, and New site says how many more fit (from Health's numbers).

## In the panel

- **Sites** in the sidebar. `/sites` lists every site, with its engine's icon. Each row shows:
  - the domain and title;
  - the engine and its version, with updates waiting: core and plugins for WordPress (`wp core check-update`, `wp plugin list --update=available`, read hourly); a newer Ghost from npm;
  - memory against the limit;
  - **Open site**, **Admin** (wp-admin or /ghost) and **Manage**.
- **New site:**
  - pick **WordPress** or **Ghost** (two large cards with what each is good for);
  - then the title, the owner's email and name, and the address (the free URL now, or a domain added on its Domains page later);
  - then the install log streams, and the owner's password is shown once.
  - The first WordPress site installs PHP first, and says so.
- **The engine page** of a site:
  - **Both:**
    - the version and **Update** (backup first);
    - **Reset owner password** (shown once);
    - the memory limit;
    - **Delete site** (type the name to confirm).
  - **WordPress only:**
    - plugins and themes with updates, and **Update all**;
    - **Lock code** and **Allow XML-RPC**;
    - PHP's memory limit and upload size;
    - **Search and replace URLs** (`wp search-replace`), offered after a domain change.
  - **Ghost only:** mail status and the Mailgun note.

## Days

1. **The PHP runtime:**
   - `service.install php`: the packages, the distro service turned off, the version checked;
   - the per-site FPM unit and pool templates;
   - the socket and its permissions;
   - Caddy's `php_fastcgi` site with the blocks;
   - an e2e with a two-file PHP test app checks that it answers, `open_basedir` holds, one site can't open another's socket or files, and PHP in uploads isn't run.
2. **WordPress:**
   - `site.create`/`site.delete` for WordPress;
   - core download, checksum and cache; the pinned wp-cli;
   - `wp-config.php`, the install, the cron timer and the mail plugin;
   - an e2e: create a site, load home and wp-login, log in, upload an image (served by Caddy), install a plugin (and see it refused when locked), back up and restore, delete.
3. **MySQL 8 and Ghost:**
   - `service.install mysql8`:
     - Oracle's tarball checked against its signature, `/opt/layer/mysql/8.4.x/`, the `mysql8` user and unit, initialized with a root login only the agent knows (socket auth);
     - a user and database per site, dumps in backups, and restore;
     - an e2e like `mongodb-e2e.sh`: sites can't read or list each other's databases.
   - `site.create` for Ghost: the npm tarball and its integrity, the install as the site's user, the config, the owner through the setup API before it's public;
   - the update path;
   - an e2e: create, owner sign-in through the admin API, a post published and served, an image upload, backup and restore, update, delete.
4. **The panel:**
   - Sites and New site, with engine choice and the one-time password;
   - the engine pages and the update checks;
   - domain changes, with search-replace or Ghost's `url`.
5. **Hardening and numbers:**
   - the wp-login jail and the XML-RPC setting;
   - a security score per site;
   - **memory with 10 idle WordPress sites, 2 Ghost sites (and MySQL 8), and 3 sites under load** (target: under 15 MB per idle WordPress);
   - the browser tour (TOUR_SITES);
   - docs, and the homepage line.
6. **Bringing sites in (later):**
   - a WordPress from an archive of its files plus a `.sql` dump (fresh salts, `wp search-replace` to the new address);
   - a Ghost from its JSON export plus its `content/images`.

## Not in v1

- PHP for GitHub projects.
- A choice of PHP version per site.
- Page caches (one-click caching for WordPress later).
- WordPress Multisite.
- Staging copies of a site.
- Redis object cache.
- Ghost's ActivityPub and Tinybird analytics (Ghost's own hosted services).

## Risks

- **Plugins and themes are untrusted code by nature.** Per-site users, sandboxes and memory limits keep a bad one inside its own site. The docs say so plainly.
- **PHP memory under load:** about 40–60 MB per worker. `MemoryMax` and at most 5 workers keep one busy site from taking the box. Day 5's numbers set the defaults.
- **MySQL 8's memory:** 350–450 MB idle, on top of each Ghost site's own. On a 2 GB box, New site says so before the first Ghost.
- **Ghost moving fast:** weekly releases, a new major about yearly. Majors aren't installed without the owner saying so.
- **Distro PHP versions differ by OS.** WordPress supports them all. Plugins that need a newer PHP are the owner's call, and the engine page shows the version.
