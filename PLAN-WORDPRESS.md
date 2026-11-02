# WordPress: one-click WordPress sites, as many as the box holds (asked 2026-11-02)

> The fifth integration, and the first that isn't ours: WordPress itself, installed and kept the way we keep our own apps. **New site → a title and a domain → a live HTTPS WordPress with its admin login, in about 20 seconds.** Each site is its own project: its own Linux user, sandbox, MariaDB database, domain, backups and logs. No Docker, and no shared PHP process between sites.

## Why it fits

- **The pitch gets bigger:** "10 WordPress sites on a $5 box, each one sandboxed." Shared hosts give you that without the isolation. Docker panels give you isolation with 150 MB+ per site. With PHP-FPM's `ondemand` mode an idle site costs about one master process (~12 MB), and MariaDB is shared and already there.
- **People ask for it first.** It's the most common reason anyone rents a VPS and installs a panel.
- **Most of the plumbing exists:**
  - per-app users, systemd sandboxes and memory limits;
  - MariaDB with a user and database per app (`mysql.add`), dumped into backups;
  - Caddy sites with automatic certificates, and domains with DNS checks;
  - cron jobs as timers, backups and restore, import, logs, alerts.

## Decisions

1. **Name.** The area and catalog entry say **WordPress**. Saying what we install ("Install WordPress", "WordPress sites") is allowed. The WordPress Foundation's trademark policy only stops us putting "WordPress" in our *product's* own name or domain, and we don't. If you'd rather have a name of our own for the area, **Sites** is the plain choice. Never call it "SelfHost WordPress" or similar.
2. **A new runtime, `php`, for WordPress only** (v1). It changes decision 3 of 2026-10-28 ("Node + static only") narrowly: the panel doesn't offer PHP for GitHub projects yet. That can come later on the same runtime.
3. **PHP from the distro, installed once** with its own button, like MongoDB:
   - `php-fpm` and the extensions WordPress wants: mysql, curl, gd, imagick, intl, mbstring, xml, zip, opcache;
   - versions: Ubuntu 24.04 ships PHP 8.3 and Debian 12 ships 8.2; 26.04's version is checked on Day 1;
   - the distro's own `php-fpm` service is disabled: nothing runs PHP until a site does.
4. **One PHP-FPM master per site,** as a sandboxed unit `app-<slug>@php.service`:
   - it runs as `app-<slug>`, with the same sandbox and `MemoryMax=` as the Node apps;
   - `pm = ondemand` (0 workers when idle, at most 5, idle ones gone after 30 s);
   - `open_basedir` to the site and its tmp folder;
   - it listens on a unix socket, `/run/layer/php/<slug>.sock` (`app-<slug>:caddy`, 660). Only Caddy can reach it: other apps can't connect, unlike a localhost port.
   - No blue/green: WordPress changes itself in place, so the unit is just restarted.
5. **The site lives in `data/`** (`/srv/apps/<slug>/data/wordpress`), so backups, restore, import and the server-move assistant work unchanged. The database dump already goes into backups. Core files add about 25 MB to each backup, which is acceptable for v1.
6. **Who can read what:**
   - Files belong to the site's user. Folders are `2750 app-<slug>:caddy` (setgid) and the umask is 027, so Caddy can read the static files WordPress writes but can't write them.
   - `wp-config.php` is 600, so only PHP reads it.
   - **Caddy blocks:**
     - `wp-config.php` and dotfiles;
     - PHP under `wp-content/uploads`;
     - `xmlrpc.php` (on by default, with a setting to allow it);
     - the readme and license files.
7. **WordPress can update itself and install plugins** (`FS_METHOD direct`), because that's what WordPress users expect. Plugins are code and run with the site's rights, and only the site's: that's the per-site user. Defaults:
   - `DISALLOW_FILE_EDIT` is always on (no code editor in wp-admin);
   - **Lock code** (`DISALLOW_FILE_MODS`) is a setting for sites that are done, with backups taken before WordPress or plugin updates run from the panel.
8. **Downloads are checked:**
   - WordPress core comes from wordpress.org (`wordpress-<version>.tar.gz` and its `.sha1`, both over HTTPS) and is cached in `/var/cache/layer/wordpress`;
   - wp-cli is a phar with a pinned version and sha512, shipped with the agent;
   - **Trust:** the checksum comes from the same host as the file, like our own catalog. That's an honest limit, and the same one WordPress's own updater has.
9. **Install is one agent action, `wordpress.create`.** It reuses `app.create` and `mysql.add`, then, as the site's user in a sandbox:
   - unpacks core;
   - writes `wp-config.php` (fresh salts, the database, `WP_HOME`/`WP_SITEURL`, HTTPS behind Caddy, `DISABLE_WP_CRON`);
   - runs `wp core install` with a random admin password, which the panel shows **once** and offers to copy.
10. **WP-Cron runs from a timer.** It goes every 5 minutes as `wp cron event run --due-now`, using the existing cron jobs, so visits never wait for it.
11. **Mail works out of the box:** a small must-use plugin points `wp_mail` at the **Email** integration's API when it's installed (a key the panel makes, as Forms does), or at the panel's SMTP settings. Without either, WordPress shows a notice instead of failing silently.
12. **Logins:** a fail2ban jail on Caddy's access log for repeated `POST /wp-login.php` (10 in 10 minutes bans for an hour). Optionally, wp-admin can be limited to the panel's allowed addresses.
13. **Many sites means separate installs, not WordPress Multisite.** Separate installs give each site its own user, database, limits and backups, so one bad plugin can't touch the others.

## In the panel

- **WordPress** in the sidebar (with **Install** until PHP is set up). `/wordpress` lists the sites. Each row shows:
  - the domain and title;
  - the WordPress version, and updates waiting (core and plugins, from `wp core check-update` and `wp plugin list --update=available`, read once an hour);
  - PHP memory against the limit;
  - **Open site**, **wp-admin** and **Manage**.
- **New site:** the title, the admin's email and username, and an address (the free URL now, or a domain added on its Domains page later). Then the install log streams, and the admin password is shown once.
- **A site is a project** (`source: wordpress`), so it gets the project pages: Domains, Logs, Backups, Cron jobs and Settings. The Environment page isn't used. It also gets a **WordPress** page:
  - the version, with **Update WordPress** (backup first, then `wp core update` and `wp core update-db`);
  - plugins and themes with updates, with **Update all**;
  - **Lock code**, **Allow XML-RPC** and the PHP memory limit and upload size;
  - **Reset admin password** (shown once);
  - **Search and replace URLs** (`wp search-replace`, after a domain change);
  - **Delete site** (type the name to confirm).
- **Changing the domain** updates `WP_HOME`/`WP_SITEURL` and offers the search-replace.
- **Projects doesn't list WordPress sites** (as with integrations). **Databases** shows each one's MariaDB, and the database viewer works on it.

## Days

1. **The PHP runtime:**
   - `service.install php` (packages, the distro service off, the version checked);
   - the per-site FPM unit and pool templates;
   - the socket and its permissions;
   - Caddy's `php_fastcgi` site with the blocks;
   - an e2e with a two-file PHP test app: it answers, `open_basedir` holds, one site can't open another's socket or files, and PHP in uploads isn't run.
2. **WordPress:**
   - `wordpress.create` and `wordpress.delete`;
   - core download, checksum and cache, and the pinned wp-cli;
   - `wp-config.php`, the install, the cron timer and the mail plugin;
   - an e2e: create a site, load the home page and wp-login, log in, upload an image (served by Caddy), a plugin install (and refused when locked), the backup and restore round trip, delete.
3. **The panel:** the WordPress area, New site, the site's WordPress page, update checks, and domain changes with search-replace.
4. **Hardening and numbers:**
   - the fail2ban jail and the xmlrpc setting;
   - the security score per site;
   - **memory with 10 idle sites and with 3 under load** (target: under 15 MB per idle site);
   - the browser tour (TOUR_WORDPRESS);
   - the docs, and the homepage line.
5. **Bringing a site in (later, if Days 1–4 go well):** import an existing WordPress from an archive of its files plus a `.sql` dump. That means checks, `wp search-replace` to the new address and fresh salts. It's what moving the user's own WordPress sites onto the box would need.

## Not in v1

- PHP for GitHub projects (Laravel and the like).
- A choice of PHP version per site.
- A page cache (Caddy or a plugin). A one-click caching plugin comes later.
- WordPress Multisite.
- Staging copies of a site (would come after the server-move assistant).
- Object cache with Redis (the per-app Redis exists; wiring it to a plugin is later).

## Risks

- **Plugins are untrusted code by nature.** Per-site users, sandboxes and memory limits contain a bad one to its own site. The docs say so plainly.
- **PHP memory per site under load:** about 40–60 MB a worker. `MemoryMax` and at most 5 workers keep a busy site from taking the box. Day 4's numbers decide the defaults.
- **Distro PHP versions differ by OS.** WordPress supports them all. Plugins that need a newer PHP are the user's call, and the WordPress page shows the version.
