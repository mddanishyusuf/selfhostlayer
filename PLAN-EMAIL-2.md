# Email, part 2: brands, contact sync, Shield and insights (asked 2026-11-04)

> Four changes to the Email integration (`catalog/email` plus the panel's `/email` pages, built in [PLAN-EMAIL.md](PLAN-EMAIL.md)):
> 1. **Brands first:** `/email` lists every brand with its logo, and you pick one.
> 2. **Sync from your apps:** sign-ups and leads in a project's own database flow into a brand's list.
> 3. **Shield:** bad and spam addresses are flagged or refused, so lists stay clean. It's modeled on PostShiba's eight checks (postshiba.com/shield).
> 4. **Insights:** every send, open and click fills in where and when contacts read, with a page that shows the list's geography and engagement.

## 1. Brands first

- **`/email` lists the brands** instead of jumping to the first one: one row each, in one card, with:
  - the brand's logo and name;
  - its sending domain and whether it's verified;
  - its contacts, and the emails sent in 30 days;
  - its provider (SMTP or SES), or "Not set up".

  **New brand** is in the header. Clicking a row opens that brand's pages, and its sidebar picker shows the same logos.
- **The logo** comes from Google's favicon service, `https://www.google.com/s2/favicons?domain=<domain>&sz=64`, using the brand's website or else its first sending domain. It loads in the browser, so Google sees the brand's domain, never anything about contacts. A brand with no domain gets its initial on a colored tile, like project marks.

## 2. Sync contacts from your apps

On a brand's **Contacts → Sync from an app**, add a source:

1. **Pick the data:** a project, one of its databases (SQLite, Postgres, MySQL or MongoDB), and a table or collection.
2. **Map the columns:**
   - which column is the **email**, and optionally which one is the **name**;
   - up to 10 more columns, which become contact fields (plan, signed-up date…).
3. **Pick the target:** the list it fills. New contacts come in subscribed, since they signed up on your own site.

**How it reads:**
- **As the app, read-only:** through the database viewer's job (`db.browse`), as the app's own user with its own logins, so no database password leaves the agent.
- **Only new rows:** it pages through by primary key (or SQLite's rowid), remembering the last one it read. MongoDB pages by `_id`.
- **When:** a first run imports everything; then every 15 minutes from the panel's monitor, and on **Sync now**.

**What it won't do:**
- **Re-subscribe someone:** a contact who unsubscribed, bounced or complained stays that way.
- **Delete contacts:** a row deleted in the app leaves its contact in Email.
- **Skip Shield:** new addresses go through it like any sign-up, minus the browser and IP checks, which a database row can't answer.

Each source shows its last sync, rows read, contacts added, and what Shield refused. Contacts it adds carry the source `sync:<project>`.

## 3. Shield

Eight checks, on by default except Free webmail. Each one can be set to **Refuse**, **Flag** or **Off**.

| Check | How, without a third-party account |
|---|---|
| **Invalid email** | The syntax, then the domain must have an MX record (or an A record) in DNS, cached a day per domain. |
| **Temporary email** | The [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) list (CC0, about 120,000 domains), refreshed weekly. |
| **Spam-listed domain** | StopForumSpam's toxic domain list, refreshed daily. |
| **Free webmail** (optional) | A bundled list of free providers (gmail.com, outlook.com…), for B2B lists that want work addresses. |
| **Bounced elsewhere** | The address hard-bounced or complained with another brand on this server. PostShiba shares this across all its customers; a self-hosted install can only share it across its own brands. |
| **Scripted browsers** | A sign-up whose User-Agent is a headless browser, curl or a script; a hidden honeypot field that got filled in; or, with the form snippet, `navigator.webdriver` set or a form submitted less than 2 seconds after it loaded. |
| **Spam-listed IP** | StopForumSpam's list of IPs seen spamming in the last 30 days, refreshed daily and kept in memory. |
| **Abusive IPs** | Tor exit nodes (the Tor Project's list, daily) and data-center ranges (a published list of cloud and hosting ranges, weekly), with data centers allowed per list. AbuseIPDB too when you add its free API key (1,000 lookups a day, cached). |

**What it does:**
- **Refused sign-ups:** the form shows the same "thanks" page, so bots learn nothing. The refusal is counted on Shield's page with its reason, never with the address.
- **Flagged contacts:** they're kept but skipped by campaigns and automations until you **Approve** them. The Contacts page has a **Flagged** filter, with the reason as a pill.
- **Checking an import:** importing contacts (a CSV, or pasted addresses) runs the address checks first, on by default. It shows the result before anything is added: how many are fine, how many each check would flag or refuse, with examples. Then you import the clean ones, or include the flagged ones as flagged.
- **Clean the list:** runs the address checks (the first five) on every existing contact. It shows how many it would flag, by check, before it flags them; then you can unsubscribe them in bulk.
- **Privacy:** the IP is used only while the sign-up is checked, and is never stored. Only the verdict and the country are kept.
- **The lists:** they live in `data/shield/` and are downloaded by Email's cron, a few MB in all. A download that fails keeps the last copy, and the Shield page shows each list's age.

**The form snippet** (`/subscribe.js`, optional): it adds the time the form loaded, `navigator.webdriver` and the visitor's time zone to a plain HTML sign-up form. Forms without it still get every other check.

## 4. Enriching contacts, and insights

**What a contact gains:**
- **Country:** from the IP of their sign-up or their clicks, looked up in the DB-IP list Email already has.
- **Time zone:** from the form snippet, or from the country when it has only one.
- **Device and email client:** from the User-Agent.
- **Activity:** first and last open, last click, open and click counts, last campaign.
- **Engagement:** active (opened or clicked in 30 days), cooling (30 to 90 days) or inactive.

**Opens are honest:**
- Gmail, Apple Mail Privacy Protection and Yahoo load images through their own servers, so an open's IP is Google's or Apple's, never the reader's. Those opens are counted, but give no country or device; only clicks do.
- Apple's opens are often automatic, so they're labeled as such and don't make a contact active by themselves.

**The contact's page:** a timeline of sign-up, sync, sends, opens and clicks, with its country and device.

**A brand's new Insights page:**
- contacts by country, as bars with a table view;
- contacts by device and email client;
- engagement (active, cooling, inactive) and how it changed over 90 days;
- growth by source (form, sync, API, import);
- the best hour to send: when clicks happen, in each contact's own time zone;
- list health: the share flagged, the bounce and complaint rates, and refusals by check.

Nothing new leaves the server: the lookups use lists stored on it, and AbuseIPDB is called only when you add its key.

## Days

1. **Brands first:** the brands list with logos, the picker's logos, and New brand.
2. **Shield's address checks:**
   - MX lookups, the disposable, toxic-domain and free-webmail lists, and the across-brands bounce check;
   - the per-check settings on a Shield page;
   - flags on contacts, the Flagged filter and Approve;
   - Clean the list.
3. **Shield's sign-up checks:** the User-Agent, honeypot, snippet timing, and the StopForumSpam IP, Tor, data-center and AbuseIPDB checks on `POST /subscribe` and the API's contact creation, plus the refusal log.
4. **Sync from your apps:** sources, the column mapping, paging by key through `db.browse`, the monitor's 15-minute runs, Sync now and the source status.
5. **Enrichment:** country, time zone, device and client, and activity on contacts, filled in from sign-ups, clicks and opens (with the proxy rules); the engagement buckets; the contact timeline.
6. **Insights, then tests:**
   - the Insights page;
   - Email's own tests for each check and the proxy rules;
   - the tour: a sync from the `next` example's SQLite into a list, a refused bot sign-up, a flagged disposable address, and a click that gives a contact its country;
   - Email's release to the catalog.

## Not in v1

- Sharing bounces across other people's installs: there's no central service.
- City-level location: DB-IP's free list is countries.
- Two-way sync, where Email writes back to the app.
