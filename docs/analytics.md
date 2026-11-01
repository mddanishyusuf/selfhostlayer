# Analytics

Analytics counts the visits to your sites on your own server, with no cookies and nothing sent anywhere else: visitors, pages, where they came from, countries and devices, the goals visitors reach, and the revenue each source brings in from Stripe, Polar, Paddle, Dodo Payments, Creem or Lemon Squeezy. It works for the apps you deploy here and for any other site you run.

## Install, and your first site

1. **Analytics** in the sidebar → **Install**. Analytics installs like one of your apps: its own Linux user and sandbox, its own folder, and a free address with HTTPS (`analytics.<your apps domain>`). For a shorter address (`stats.example.com`), add one on its **Domains** page.
2. **Add a site:** a domain like `example.com`, or one of your projects in one click. `www.` always counts as the site; its subdomains count too if you choose.
3. **Paste one line** into every page of the site, before `</head>`. The site's Overview shows it, with **Copy**, until the first visit comes in (and its **Settings** page always does):

```html
<script defer src="https://analytics.example.com/script.js" data-site="example.com"></script>
```

The visits show up within a second.

## Your sites

**Analytics** in the sidebar opens the list of your sites, busiest first. Each shows its visitors in the last 24 hours (and how that compares with the 24 hours before), its pageviews, an hourly chart, where most visitors came from, and who's on it now. Click one to open it. **Add a site** is at the top.

## Analytics' own sidebar

Opening a site in Analytics shrinks the panel's sidebar to its icons, and Analytics' own sidebar opens beside it:

- **The site picker** at the top: every site, with its visitors in the last 24 hours and a green dot when someone's on it now, then **All sites** (back to the list) and **Add a site**.
- **The site's pages:** Overview, Realtime, Pages, Users, Goals, Revenue, Outbound and Settings.
- **Analytics** at the bottom, with its version: its deployments, logs, backups and updates.

The range you pick (today, the last 24 hours, or the last 7, 30 or 90 days) carries from page to page. On phones, the picker and the pages are a row of tabs above the page.

Click a row on Overview, Pages or Revenue to show only those visits, on the whole page: a page, a source, a country, a browser. The filters show above the numbers; × removes one.

## Overview

- **Totals:** visitors (with how many are on the site now), visits, pageviews, bounce rate (visits that saw one page) and visit time, each compared with the period before.
- **Revenue,** once a payment provider is connected: revenue, payments and customers, and revenue per visitor.
- **Visitors** over time, by the hour or the day (UTC).
- **Pages:** top pages, entry pages and exit pages.
- **Sources:** the sites visitors came from, and UTM source, medium and campaign (`?utm_source=newsletter`, or `?ref=`).
- **Countries**, and **devices**, browsers, operating systems and screen sizes.
- **Events** (your custom events, below) and **Goals**.

## Realtime

Who's on the site in the last 5 minutes, visitors by the minute over the last 30, the pages they're on, where they came from, their countries and devices, and the latest pageviews and events as they come. It refreshes every 5 seconds; a row opens its visit.

## Pages

Every page in the range with its visitors, views, entries (visits that started there), exits (visits that ended there), bounce rate (of the visits that started there, the ones that saw nothing else) and time on page (until the next page, or the end of the visit). Search, and sort by any column.

## Users

The visits one by one, newest first: when, where from, the first and last page, the country, the device and browser, and what the visit paid. With no cookies, nobody is followed from one day to the next, so a row is one visit: one visitor's pages less than 30 minutes apart.

Search by a page, source or campaign; show only the visits that reached a goal, or only the ones that paid. A visit opens to its journey: every page, custom event and link out, in order, with the time from its start, and its payments.

## Goals

A goal is a page or a custom event:

- **A page:** `/thank-you`, or with `*` for any characters, `/docs/*` for every page under `/docs`.
- **An event:** the name given to `window.shl.track`, like `Signup`.

**New goal** adds one. Each goal counts the visitors who reached it in the range, what share of all visitors that is, the visits, and the revenue those visits brought in. Its **…** menu shows its visits (on Users), changes it or deletes it.

## Revenue

Revenue shows which sources, campaigns, first pages and countries bring paying customers, with no cookies:

1. **Connect a provider** on the site's **Settings** page, under **Revenue attribution**: a tab for each provider, with what it needs, its checkout code, and its status once connected (a dot on the tab).
   - **Stripe:** a restricted key (Developers → API keys → Create restricted key) with **Read** on Checkout Sessions and Invoices. Analytics reads completed checkouts, and paid invoices for renewals.
   - **Polar:** an organization access token (Settings → Developers) with `orders:read`, for production or the sandbox. Analytics reads paid orders.
   - **Paddle:** an API key (Developer tools → Authentication) with **Read** on transactions; a sandbox key (`pdl_sdbx_…`) says so itself. Analytics reads completed transactions, and counts the ones a subscription made later as renewals.
   - **Dodo Payments:** an API key (Developer → API Keys), live or test. Analytics reads succeeded payments, in your account's own currency.
   - **Creem** and **Lemon Squeezy** don't show a checkout's data in their APIs, so they send their payments instead: add a webhook in the provider with the address the tab shows (`https://<analytics address>/webhooks/<provider>/<site>`) and its events, and the webhook's signing secret in the tab. Creem makes the secret (Developers → Webhooks; events `checkout.completed` and `subscription.paid`). For Lemon Squeezy (Settings → Webhooks; events `order_created` and `subscription_payment_success`), the tab makes one to paste there. Every webhook is checked against the secret, and one with another signature is refused; until the first payment comes in, the tab says so, since a secret pasted wrong is the likely reason. Test mode counts the provider's test payments only.

   Analytics checks a key with one small request, then reads the last 90 days of payments, and new ones every 10 minutes. **Sync now** reads them at once. Webhooks bring each payment as it's made.

2. **Credit payments to visits:** the script names each visit. Pass it into your checkout as `shl_visit`. The tab of each provider has the code, like this for Stripe:

   ```js
   // In the page: the visit, from the script
   const visit = window.shl ? await window.shl.ready : null;
   await fetch("/api/checkout", { method: "POST", body: JSON.stringify({ visit }) });

   // On your server (stripe-node): the visit in the Checkout Session's metadata
   const session = await stripe.checkout.sessions.create({
     mode: "payment",
     line_items: [{ price: "price_…", quantity: 1 }],
     success_url: "https://example.com/thanks",
     metadata: { shl_visit: visit },
   });
   ```

   It goes in the checkout's `metadata` with Stripe, Polar, Dodo Payments and Creem, in `customData` with Paddle.js (`custom_data` on a transaction made through Paddle's API), and in `checkoutData.custom` with Lemon Squeezy. Links on your pages get the visit added when they're clicked, with nothing to add:
   - **Stripe Payment Links** (`buy.stripe.com`)
   - **Dodo Payments' payment links** (`checkout.dodopayments.com/buy/…`)
   - **Lemon Squeezy's buy links** (`….lemonsqueezy.com/buy/…`)

A payment with the visit is credited to that visit's source, campaign, first page and country. A renewal, or a customer's later purchase, goes to their first visit, and so does a free trial's first payment. Payments with no visit count in the totals as unattributed.

The Revenue page has the totals (revenue, payments, customers, revenue per visitor, the share credited to a visit, and renewals), revenue over time, revenue by source, UTM source, campaign, first page and country (each with what a visitor that way was worth), and the latest payments, each opening its visit.

What's kept for each payment: the amount without tax, its currency and time, and the provider's id for the customer, never their email or name. Amounts are before refunds and the provider's fees. With payments in more than one currency, the numbers are in the currency of most payments, and the others are listed beside them. Disconnecting a provider removes its payments from the numbers.

## Outbound

The script counts clicks on links to other sites by itself. **Outbound** lists the sites people left for, or each link, with visitors and clicks. Clicks are the event `Outbound link`, with the address (without its query string).

## Custom events

The script adds `window.shl.track`. Call it for anything worth counting:

```js
window.shl.track("Signup", { plan: "pro" });
```

Names are up to 60 letters, digits, spaces and `. _ : / -`; properties are up to 10, each a short text, number or true/false.

## A site's settings

- **The line to paste**, with **Copy**.
- **Subdomains:** whether `blog.example.com` counts as `example.com`.
- **Revenue:** how to credit payments to visits, and each provider's key, status (its last sync, or why it failed), mode and payments, with **Replace the key** and **Disconnect**.
- **Remove the site:** deletes everything counted for it, payments included. Type its domain to confirm.

## What's counted, and what isn't

- **No cookies and no storage** in the visitor's browser. A visitor is a hash of their address and browser under a key that changes every day and is then thrown away: the same person on two days counts twice, and nobody can be followed over time. The visit's id (`window.shl.visit`) lives only in the page's memory.
- **No address is stored.** It's used for the hash and the country, then forgotten. Countries come from DB-IP's free list ([db-ip.com](https://db-ip.com), CC BY 4.0), looked up on your server; Analytics fetches the newest list every month. Behind Cloudflare's proxy, the visitor's address comes from Cloudflare's header, only when the request really comes from Cloudflare.
- **Not counted:** bots (search engines, link previews, monitors, scripts), automated browsers, pages on `localhost`, and pages on a domain that isn't the site's.
- **A visit** is one visitor's pages less than 30 minutes apart. Its time runs from its first event to its last, including when the visitor leaves the last page.
- **How long it's kept:** 365 days, then deleted every night. Change it on Analytics' Settings page. A visit that brought a payment is kept (its pages go), so its customer's renewals still know where they came from.
- **Provider keys** are kept encrypted in Analytics' database, under a key made from its admin token, so the database alone doesn't give them away.

## Updates, backups and removing it

- **Updates** come from the Self Host Layer catalog, as for every integration: **Update** on Integrations and on its Settings page backs it up first when backups are on, then starts the new version beside the old one.
- **Backups** include `data/analytics.db`, checked, like your apps' SQLite files.
- **Uninstall** (Analytics' Settings page) removes Analytics itself; its `data/` folder is kept in `/var/lib/layer-agent/archive/` unless you say otherwise.

## On the server

```sh
layer logs analytics                             # its log
sqlite3 /srv/apps/analytics/data/analytics.db    # its database (as root)
```

Analytics listens on `127.0.0.1` only; Caddy brings the events to it. The panel reads the numbers through Analytics' admin API, which answers only requests made on the server with the token made at install. The payment providers are the only places Analytics calls out to, with the keys you give it, besides DB-IP's monthly list.
