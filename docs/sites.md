# Sites

**Sites** installs WordPress and Ghost in one click, as many as your server holds. Each site is its own install with:

- its own Linux user and sandbox;
- a memory limit;
- its own database;
- an address with HTTPS;
- backups and logs.

Nothing is shared between sites: a bad plugin on one can't touch another.

## A new site

**Sites → New site:**

1. Pick **WordPress** or **Ghost**.
2. Give it a title. You can also give it a name: its folder, its Linux user and its free address. Without one, the name comes from the title.
3. Enter your name and email. They become the site's **owner**.
4. Press **Install**. You watch the install's log. A WordPress site is live in under a minute.

**Your first site of each kind takes a little longer:**

- **WordPress:** the first site installs PHP once, plus MariaDB if your server doesn't have it yet.
- **Ghost:** the first site installs MySQL 8 once. It's Oracle's own build, checked against Oracle's signature. On ARM servers that's an 800 MB download.

**The owner's account is created during the install.** With a hand-made WordPress or Ghost, whoever opens the fresh site first can claim it; here there's never that window. The owner's password is shown **once**, on the site's page: save it in your password manager, then press **I've saved it**.

## A site's pages

A site has a project's pages: Overview, Deployments, Logs, Domains, Databases, Backups and Settings. On top of those is its engine's page.

**WordPress:**

- **The version, with Update.** Minor releases install themselves. Updates you start from here are backed up first, when backups are on. Plugins and themes with updates have their own buttons.
- **Lock code.** Locked, wp-admin can't install or update plugins, themes or WordPress itself. Use it for a site that's finished. Updates from the panel still work.
- **XML-RPC** is off by default: `/xmlrpc.php` is a favourite of password guessers. Turn it on only for an app that needs it, like the WordPress mobile app or Jetpack.
- **A new password** for the owner, shown once.

**Ghost:**

- **The version, with Update.** It's backed up first, when backups are on. Then the new version is installed beside the running one. Ghost stops for a moment while it moves its database to the new version.
- **Email:** Ghost sends sign-in and invite emails over SMTP, and newsletters only through Mailgun. Set both in Ghost's own settings.

**Domains** work as for any project: add yours on the site's Domains page. For WordPress, the site's address changes with it.

## Bringing a site in

**WordPress:** on the site's WordPress page, **Bring a site in** takes an archive (`.zip`, `.tar.gz` or `.tar`) holding the old site's `wp-content` folder and a `.sql` dump of its database. Most backup plugins make exactly that, or by hand:

```sh
wp db export backup.sql && tar -czf site.tar.gz wp-content backup.sql
```

The import:
- runs as the site;
- loads the dump into the site's own database, keeping its table prefix;
- puts its `wp-content` in place, with the site's previous one kept as `wp-content.before-import`;
- replaces the old address with the site's everywhere in the database.

`wp-config.php` stays the server's: this site's database and fresh salts.

**Ghost:** create the site, then use Ghost's own **Settings → Import/Export** to bring in the old site's export (posts, pages, tags, members). Copy its images over SSH:

```sh
rsync -a content/images/ root@new-server:/srv/apps/<site>/data/content/images/
ssh root@new-server chown -R app-<site>:app-<site> /srv/apps/<site>/data/content/images
```

## Safety

**Every WordPress site runs its own PHP**, as its own user, in a systemd sandbox, with:

- **no access outside its own folder** (`open_basedir`);
- **no shell commands** (`exec`, `system` and the like are disabled);
- its own `/tmp`;
- PHP processes only while requests come in, so an idle site costs one small process.

Only Caddy can reach a site's PHP: other apps on the server can't connect to it.

**Caddy never serves:**

- `wp-config.php`, which only the site's own user can read;
- dotfiles;
- PHP files in `wp-content/uploads`;
- `readme.html` and `license.txt`;
- `xmlrpc.php`, unless you turn XML-RPC on.

**Sign-ins:** 10 failed sign-ins from one address in 10 minutes ban it for an hour (fail2ban). wp-admin's code editor is always off.

**WordPress itself:**

- **Downloads:** WordPress comes from wordpress.org and is checked against wordpress.org's checksum. wp-cli is a pinned version, checked against its sha512.
- **WP-Cron** runs every 5 minutes from a timer, as the site's user, so visitors never wait for it.

**Ghost** runs like any Node app here: its own user and sandbox, blue/green restarts, and the health check on its admin API.

- **Downloads:** it comes from the npm registry, checked against the registry's integrity hash.
- **Its database:** MySQL 8 runs on `127.0.0.1:3307`, beside MariaDB. Every Ghost site has its own MySQL user, which can only reach its own database.

**Plugins and themes are code.** They run with their own site's rights, and only those. That's the point of a user and sandbox per site.

## On the server

```sh
layer logs <site>                                        # the site's log
systemctl status app-<site>-php                          # a WordPress site's PHP
ls /srv/apps/<site>/data/wordpress                       # a WordPress site's files
ls /srv/apps/<site>/data/content                         # a Ghost site's content (images, themes)
systemctl status layer-mysql8                            # MySQL 8, for Ghost
```

A WordPress site's `wp-config.php` is generated from the panel's settings, so change things in the panel instead of editing it. `layer repair` puts back the PHP and WP-Cron units, and MySQL 8's config, if they're edited or deleted by hand.
