# Links

Links is a link shortener that runs on your own server: `go.example.com/launch` goes to any page, and you see how many people clicked, from where and on what. You install it from **Integrations**, manage it in the panel, and every click is counted without cookies.

## Install

**Integrations → Links → Install.** Links installs like one of your apps: its own Linux user and sandbox, its own folder, and a free address with HTTPS (`links.<your apps domain>`). It works at once on that address.

For your own short domain, open its **Domains** page and add one, like `go.example.com`. The panel shows the DNS record to create, checks it, and gets a certificate. Once it's live, short links show on it.

## Links

The **Links** page lists your links, with search, tags and sorting by date, clicks or name.

- **New link:** where it goes, and the short part (`go.example.com/launch`). Leave the short part empty for 7 random letters and digits. Short links ignore case: `Launch` and `launch` are the same link.
- **Title and tags:** for you; visitors never see them. Tags filter the list.
- **Redirect:** 302 (the default) counts every click, because browsers don't keep it. 301 and 308 are kept by browsers for a day, so repeat visits from the same browser aren't counted. 307 and 308 keep the request's method.
- **Query string:** `?ref=newsletter` on the short link is added to the target, unless you turn that off for the link. Parameters the target already has keep the target's values, so nobody can swap your referral code by sharing the short link with their own.
- **Password:** visitors type it before they're sent on. A correct password is remembered by that browser for 30 days, for that link only. Changing the password asks again.
- **Expires:** after that time, the link shows "not active" instead of redirecting.
- **Turn off:** the link shows "not active" until you turn it back on.
- **QR code:** for any link, as SVG or a 1024px PNG.
- **Delete:** type the link's name to confirm. Its clicks go too.

Unknown short links show a plain "not found" page, and the bare domain a short page, unless you choose where they go in Settings.

## Stats

The **Stats** page shows the last 24 hours, 7 days or 30 days, for every link or one (open it from a link's click count):

- clicks and visitors over time;
- top links, referring sites, countries, devices, browsers and operating systems.

**What's counted, and what isn't:**

- **No cookies, and no addresses stored.** A visitor is counted with a hash of their address and browser under a key that changes every day and is then thrown away. Nobody can be followed from one day to the next, and the same person on two days counts twice.
- **Countries** come from the visitor's address, looked up on your server in DB-IP's free country list ([db-ip.com](https://db-ip.com), CC BY 4.0) and then forgotten. Links fetches the newest list every month. Behind Cloudflare's proxy, Links takes the visitor's address from Cloudflare's header, but only when the request really comes from Cloudflare.
- **Bots** (search engines, link previews from chat apps, monitors, scripts) are counted apart and left out unless you choose **With bots**.
- **Old clicks:** after 90 days (Settings), each click becomes part of daily totals: the numbers stay, the details go.

## API

The **API** page makes tokens for scripts and other apps. A token is shown once; only its hash is kept. Each token can make, change and delete any link, 120 requests a minute.

```sh
curl -X POST https://go.example.com/api/v1/links \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"target": "https://example.com/launch", "slug": "launch", "tags": ["twitter"]}'
curl "https://go.example.com/api/v1/links?q=launch&sort=clicks" -H "Authorization: Bearer $TOKEN"
curl -X PATCH https://go.example.com/api/v1/links/launch -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"disabled": true}'
curl -X DELETE https://go.example.com/api/v1/links/launch -H "Authorization: Bearer $TOKEN"
```

A link has `target`, `slug`, `title`, `tags`, `redirect` (301, 302, 307 or 308), `passQuery`, `password` (write only), `expiresAt` (a date) and `disabled`. Answers include `shortUrl` and `clicks`, and errors name the field that's wrong.

**CSV:** export every link, or import a file from Links or another shortener. Columns named `url`, `long_url` or `destination` give the target; `slug`, `keyword` or `back_half` the short part; `title` and `tags` too. Lines that can't be links are skipped, and the panel says why.

## Settings

Its **Settings** page has, besides the memory limit and Uninstall:

- where the bare domain goes (your site, say);
- where unknown short links go;
- the redirect new links get;
- how many days each click is kept before it becomes daily totals.

They're saved in Links and used at once, with no restart.

## Updates, backups and removing it

- **Updates** come from the Self Host Layer catalog. When a newer Links is out, Integrations and its Settings page show **Update**. An update backs Links' data up first when backups are on, then starts the new version beside the old one: no downtime, and your links and stats stay.
- **Backups** work as for your apps: `data/links.db` is checked and backed up with the rest of the app's data, and its Backups page restores it.
- **Uninstall** (its Settings page) stops it and removes its user, unit, cron jobs and Caddy site. Its `data/` folder is kept in `/var/lib/layer-agent/archive/` unless you say otherwise.

## On the server

```sh
layer logs links                         # its log
sqlite3 /srv/apps/links/data/links.db    # its database (as root)
```

Links listens on `127.0.0.1` only; Caddy brings visitors to it. The panel manages it through Links' admin API, which answers only requests made on the server with the token made at install, never anything through Caddy.
