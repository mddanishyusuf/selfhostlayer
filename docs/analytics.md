# Analytics

Analytics counts the visits to your sites on your own server, with no cookies and nothing sent anywhere else: visitors, pages, where they came from, countries and devices. It works for the apps you deploy here and for any other site you run.

## Install, and your first site

1. **Analytics** in the sidebar → **Install**. Analytics installs like one of your apps: its own Linux user and sandbox, its own folder, and a free address with HTTPS (`analytics.<your apps domain>`). For a shorter address (`stats.example.com`), add one on its **Domains** page.
2. **Add a site:** a domain like `example.com`, or one of your projects in one click. `www.` always counts as the site; its subdomains count too if you choose.
3. **Paste one line** into every page of the site, before `</head>`. The Analytics page shows it, with **Copy**:

```html
<script defer src="https://analytics.example.com/script.js" data-site="example.com"></script>
```

The visits show up within a second.

## The dashboard

Pick a site and a range: today, the last 24 hours, or the last 7, 30 or 90 days.

- **Totals:** visitors (with how many are on the site now), visits, pageviews, bounce rate (visits that saw one page) and visit time, each compared with the period before.
- **Visitors** over time, by the hour or the day (UTC).
- **Pages:** top pages, entry pages and exit pages.
- **Sources:** the sites visitors came from, and UTM source, medium and campaign (`?utm_source=newsletter`, or `?ref=`).
- **Countries**, and **devices**, browsers, operating systems and screen sizes.
- **Events:** your custom events (below).

Click any row to show only those visits, on the whole page: a page, a source, a country, a browser. The filters show above the numbers; × removes one.

## Custom events

The script adds `window.shl.track`. Call it for anything worth counting:

```js
window.shl.track("Signup", { plan: "pro" });
```

Names are up to 60 letters, digits, spaces and `. _ : / -`; properties are up to 10, each a short text, number or true/false.

## What's counted, and what isn't

- **No cookies and no storage** in the visitor's browser. A visitor is a hash of their address and browser under a key that changes every day and is then thrown away: the same person on two days counts twice, and nobody can be followed over time.
- **No address is stored.** It's used for the hash and the country, then forgotten. Countries come from DB-IP's free list ([db-ip.com](https://db-ip.com), CC BY 4.0), looked up on your server; Analytics fetches the newest list every month. Behind Cloudflare's proxy, the visitor's address comes from Cloudflare's header, only when the request really comes from Cloudflare.
- **Not counted:** bots (search engines, link previews, monitors, scripts), automated browsers, pages on `localhost`, and pages on a domain that isn't the site's.
- **A visit** is one visitor's pages less than 30 minutes apart. Its time runs from its first event to its last, including when the visitor leaves the last page.
- **How long it's kept:** 365 days, then deleted every night. Change it on Analytics' Settings page.

## Updates, backups and removing it

- **Updates** come from the Self Host Layer catalog, as for every integration: **Update** on Integrations and on its Settings page backs it up first when backups are on, then starts the new version beside the old one.
- **Backups** include `data/analytics.db`, checked, like your apps' SQLite files.
- **Removing a site** (its Setup card) deletes what was counted for it. **Uninstall** (Analytics' Settings page) removes Analytics itself; its `data/` folder is kept in `/var/lib/layer-agent/archive/` unless you say otherwise.

## On the server

```sh
layer logs analytics                             # its log
sqlite3 /srv/apps/analytics/data/analytics.db    # its database (as root)
```

Analytics listens on `127.0.0.1` only; Caddy brings the events to it. The panel reads the numbers through Analytics' admin API, which answers only requests made on the server with the token made at install.
