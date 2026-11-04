# Email

Email sends your products' email from your own server: newsletters to your lists, transactional email from your apps (receipts, password resets) through an API that works with Resend's SDKs, and automations like a welcome series. It sends through any SMTP provider or Amazon SES, signs with DKIM, and handles unsubscribes, bounces and complaints. One install serves any number of brands.

## Install, and your first brand

1. **Email** in the sidebar → **Install**. Email installs like one of your apps: its own Linux user and sandbox, its own folder, and a free address with HTTPS (`email.<your apps domain>`). Its emails' links (unsubscribe, tracking) and its API use that address; for your own (`mail.example.com`), add one on its **Domains** page.
2. **Add a brand:** your product's name and the address it sends from. Each brand has its own provider, domains, contacts, campaigns, automations, templates and API keys.
3. The brand's **Overview** lists what it still needs before it can send: a provider, a verified domain, a From address on it, and a list.

**Email** in the sidebar lists your brands: each one's logo, sending domain, contacts, emails sent in 30 days and provider, with **New brand** at the top. A brand's logo is its website's icon (or its sending domain's) from Google's favicon service, so your browser asks Google for it with the domain, and nothing else. A brand with neither shows its initial.

Opening a brand shrinks the panel's sidebar to its icons and opens Email's own sidebar beside it: a brand picker at the top (with **All brands** and **Add a brand**), then the brand's pages. On phones, the picker and the pages are a row of tabs above the page.

## Sending: SMTP or Amazon SES

On the brand's **Settings** page, under **Provider**:

- **SMTP** works with any provider (Amazon SES's SMTP, Postmark, Brevo, Mailgun, Resend, your own Postfix): host, port, security and the username and password. Use port **587** with STARTTLS (or 465 with TLS): many servers can't send on port 25, and Hetzner blocks 25 and 465 for new accounts. Credentials are never sent unencrypted unless security is set to None.
- **Amazon SES** uses SES's API in the region you pick (every region SES runs in is listed, and another can be typed in) with an IAM user's access key. Changing the region or the key's account sets the brand's domains up again there: each needs **Check** once more, and bounce handling set up again. The user needs `ses:SendEmail`, `ses:GetAccount`, `ses:CreateEmailIdentity`, `ses:GetEmailIdentity`, `ses:DeleteEmailIdentity`, `ses:CreateConfigurationSet`, `ses:CreateConfigurationSetEventDestination`, `sns:CreateTopic` and `sns:Subscribe`. A new SES account is in its sandbox: it sends only to verified addresses, one email a second, until AWS gives it production access.

**Send test** sends a real email; **Check the connection** logs in (SMTP) or reads the account's quota and sandbox state (SES) without sending. Passwords and keys are kept encrypted.

**Bounces and complaints with SES:** **Set up bounce handling** creates an SNS topic, subscribes this server to it, and sends SES's bounces, complaints and deliveries there. Without it, addresses that bounce stay on your lists. With SMTP, a server's refusal (550, no such user) is a bounce; bounce emails that come later go to your From address's mailbox.

**Sending** sets how many emails a second the brand sends (at most 500; SES gives each account its own rate) and whether opens and clicks are counted.

## Domains

Mail goes out only from a verified domain of the brand. **Domains** → **Add domain** shows the records to create at your DNS host, each with **Copy**:

- **DKIM** (required). With SMTP, Email signs every email with a key of its own: a TXT record at `shl<brand>._domainkey.<domain>`. With SES, SES signs with its own keys: three CNAME records for its Easy DKIM.
- **SPF** (recommended): your provider's `include:` in the domain's one SPF record.
- **DMARC** (recommended): start with `v=DMARC1; p=none;`, then tighten it once mail passes.

**Check** looks the records up in public DNS (Cloudflare's and Google's resolvers). The domain is verified once DKIM is there; with SES, once SES says so. A verified domain's records fold away under **DNS records**, which opens them again.

## Contacts and lists

Each contact has an address, a name, custom fields, the lists it's in, and a status:

- **Subscribed** gets campaigns and automations.
- **Unconfirmed** is waiting for a double opt-in click.
- **Unsubscribed**, **bounced** and **complained** get nothing more.

**Add contact** adds one. **Import** takes a CSV with an email column, and name (or first and last name); every other column becomes a custom field. Imports never subscribe someone who unsubscribed, and never start an automation. **CSV** exports the contacts shown.

**Import** takes a CSV file of any size up to 1 GB, and runs on the server:

1. **Upload:** the file goes to Email, with a progress bar.
2. **Map the columns:** say what each one is: the email, the name (or first and last name), a contact field (name it), or skip it. It's guessed from the headers, and a few rows are shown under each.
3. **Start:** with **Check the addresses with Shield** (on by default), invalid, temporary and spam-listed addresses stay out by the brand's [Shield](#shield) settings. **Check everything first** reads the whole file with Shield and waits, showing what each check found, with examples. Then you import leaving refused addresses out, or bring them in flagged.

The import runs 1,000 rows at a time with a short pause between batches, so sending and the API stay quick during an import of millions. Its progress is saved after each batch. You can close the dialog or leave the page, and Contacts shows it running with **Cancel**; what's imported by then stays. If Email restarts, the import carries on from its last batch. When it's done, Contacts shows what was added, updated, flagged, refused and skipped, with the skipped rows' line numbers.

**Suppressed** (on Contacts) lists the addresses nothing is sent to, transactional email included: hard bounces, spam complaints, and addresses added by hand.

**Lists** group contacts. Each list has a signup endpoint, `https://<email address>/subscribe/<key>`, which takes a plain HTML form, or JSON with `Accept: application/json`. The Lists page has a form to paste:

- `email` is required; `name` and any other field go on a new contact.
- A hidden `_hp` field keeps bots out.
- `redirect` sends the visitor to your thank-you page: on the brand's website, its sending domain, or the site the form is on.
- With **double opt-in**, new signups get an email with a link to confirm first. The link opens a page with a **Confirm** button: mail scanners open every link in an email, so only the button confirms.

Anyone can send a signup form with any address, so it never changes someone who's already a contact: it only adds them to the list. Their name and fields stay, someone waiting to confirm still has to, and someone who unsubscribed stays unsubscribed. They're sent a link to come back instead (it works for a week), and only that link resubscribes them. A form sends at most one such email an address a day, and takes 10 signups a minute from one address.

## Shield

Shield keeps bad and spam addresses off a brand's lists. Its page has eight checks, each set to **Refuse**, **Flag** or **Off**:

| Check | What it catches | Default |
|---|---|---|
| Invalid email | Malformed addresses, and domains with no mail server (an MX record, or an address to fall back to). A DNS lookup that times out refuses nobody. | Refuse |
| Temporary email | Throwaway inbox domains, from the [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) list. | Refuse |
| Spam-listed domain | Email domains listed by StopForumSpam. | Refuse |
| Free webmail | Gmail, Outlook and the like, for B2B sign-ups that should use a work address. | Off |
| Bounced elsewhere | Addresses that hard-bounced or complained with another brand on this server. | Flag |
| Scripted browsers | Headless browsers, curl and scripts, the hidden field filled in, and (with the form snippet) a browser driven by a script or a form sent under 2 seconds after it loaded. | Refuse |
| Spam-listed IP | IPs StopForumSpam saw spamming in the last 30 days. | Refuse |
| Abusive IPs | Tor exit nodes and data centers (allowed with **Allow sign-ups from data centers**), and AbuseIPDB's reports when you add its key. | Refuse |

The first five need only the address, so they run on every way in: sign-up forms, the API, imports and syncs. The last three need a browser's request, so only sign-up forms get them.

- **Refuse** keeps the address out. A sign-up form still says thanks, so a bot learns nothing, and the API answers 422 with the reason.
- **Flag** keeps the contact, but campaigns, automations and confirmation emails skip it until you **Approve** it on its page.
- **Clean the list** runs the address checks on every subscribed and unconfirmed contact you haven't approved, 1,000 at a time in the background (its progress survives a restart). It shows what each check found, then flags or unsubscribes the ones you pick.
- **The form snippet** is optional. On a sign-up form that posts to a list, it adds the hidden field, how long the page was open, whether a script drives the browser, and the visitor's time zone:
  ```html
  <script src="https://<email address>/subscribe.js" defer></script>
  ```
- **AbuseIPDB** is optional too: its free key (1,000 lookups a day) is kept encrypted, and only sign-up IPs are sent to it.

**Privacy:** a sign-up's IP is used only while it's checked, and never stored. Shield's page counts refusals and flags by check and by where they came from, never with the address.

**The lists** are downloaded by Email and kept in its data folder: temporary domains and data-center ranges weekly, StopForumSpam's lists and Tor's daily. A failed download keeps the last copy, and the page shows each list's age, with **Download them now**.

## Sync from your apps

On a brand's **Sync** page, **Add a source** takes sign-ups or leads from one of your projects' databases (SQLite, Postgres, MySQL or MongoDB) into a list:

1. Pick the project, the database and the table. A few of its rows are shown.
2. Pick the email column (it's guessed), optionally the name column, and up to 10 more columns as contact fields.
3. Pick the list. **Add and sync now** runs the first sync.

How it works:

- **Read-only, as the app:** the panel reads the table through the database viewer, as the app's own user with its own logins, so no database password leaves the server.
- **When:** every 15 minutes, and on **Sync now**.
- **Only new rows:** a table with a single primary key is read after the last key it saw. One without is read whole each time, and contacts already in Email are only updated.
- **New contacts** come in subscribed, through Shield's address checks.
- **What it never does:** bring back someone who unsubscribed or bounced, or delete a contact whose row was deleted.

Each source shows its last sync: rows read, contacts added, and what Shield refused or flagged.

## Insights

A brand's **Insights** page shows:

- **Engagement:** subscribed contacts by their last open or click (active within 30 days, cooling within 90, inactive, or no opens yet).
- **Countries**, **devices** and **email apps**.
- **The best hour to send:** clicks over 90 days by the hour in each contact's own time zone.
- **New contacts** by week and where they came from: forms, syncs, the API, imports.
- **List health:** bounces and complaints against the thresholds mailbox providers filter at (2% and 0.1%), plus Shield's flags and refusals.

A contact's page shows its profile (country, time zone, device and email app, opens and clicks) and a timeline of its opens, clicks and how it was added.

**Where it comes from:**

- **Country:** the IP of a sign-up or a click, looked up in DB-IP's free list on the server. The IP is never kept.
- **Time zone:** the form snippet.
- **Device and app:** the User-Agent.

Gmail and Yahoo load images through their own servers, so their opens are counted but tell nothing about the reader. Apple Mail Privacy Protection loads them for everyone, often without anyone reading, so its opens are counted but don't make a contact active.

## Campaigns

**New campaign** → a draft. The editor has:

- subject and preview text, the sender, and the lists it goes to (and lists to leave out);
- the content in **Markdown**, made into a clean, responsive email with your address and the unsubscribe link in the footer, or in **HTML** for full control;
- a live preview, as a contact would see it.

Markdown: `# headings`, `**bold**`, `*italic*`, `[links](https://…)`, `![images](https://…)`, `- lists`, `> quotes`, `---`, and `[[Button](https://…)]` on a line of its own.

**Merge tags** fill in each contact's details: `{{first_name}}`, `{{name}}`, `{{email}}`, `{{fields.plan}}`, and a fallback with `{{first_name|there}}`. `{{unsubscribe_url}}` is the contact's unsubscribe link; an HTML email without one gets a footer with it.

**Save and send test** sends a test to an address. **Send now…** (after showing how many contacts it goes to) or **Schedule** queues it; it then goes out at the brand's rate. While it sends, **Pause**, **Resume** and **Cancel** are on its page.

Every campaign email carries RFC 8058's one-click unsubscribe, which Gmail and Yahoo show next to the sender. A campaign pauses by itself when more than 5% of what it sent bounced, or 0.3% was marked as spam (after 200 emails), as SES would pause your account.

Its **report** shows what was sent, opened, clicked, bounced and unsubscribed, the links clicked, and the email itself.

## Automations

An automation starts for a subscribed contact when they **join a list** (not from an import) or when your app **sends an event** (`POST /events`). It runs once per contact through its steps:

- **Email:** written like a campaign, with the event's data as `{{data.x}}`.
- **Wait:** minutes, hours or days.
- **Add to a list** and **Remove from a list.**

**Turn on** checks that every email step can send. Its page lists each run, and the step it's at. A contact who unsubscribes, bounces or complains leaves at once.

## The transactional API

**API** → **Create key** makes a key for the brand (`em_…`, shown once; only its hash is kept). The API is on Email's address, and sending takes Resend's JSON, so Resend's SDKs work with it as their base URL:

```sh
curl https://email.example.com/emails \
  -H "Authorization: Bearer em_…" \
  -H "Content-Type: application/json" \
  -d '{"from": "Piqo <hello@piqo.app>", "to": "ada@example.com", "subject": "Your receipt", "html": "<p>Thanks!</p>"}'
```

- `POST /emails` takes:
  - `from`, `to` (one address or a list), `cc`, `bcc`, `reply_to`;
  - `subject`, `html` and `text`, or `template: { id, variables }`;
  - `headers`;
  - `attachments: [{ filename, content (base64) }]`, up to 10 MB;
  - `tags` and `scheduled_at` (within 30 days).

  It answers `{ "id": … }`; an `Idempotency-Key` header sends it once even when retried.
- `POST /emails/batch` takes up to 100 of them: all are checked before any is sent.
- `GET /emails/:id` gives its status (`last_event`: sent, delivered, opened, clicked, bounced…).
- `POST /contacts` adds or updates a contact (`email`, `name`, `fields`, `lists`, `unsubscribed`). `GET` and `DELETE /contacts/:email` read and remove one.
- `POST /events` with `{ "email", "name", "data" }` starts the automations listening for that event.

Everything is under `/v1/` too. The From address must be on a verified domain of the brand, and suppressed addresses are left out. Errors are Resend's shape: `{ "statusCode", "name", "message" }`. Each key may make 20 requests a second.

**Templates** hold emails the API sends with `template: { id, variables }`: a subject and content (Markdown or HTML) with `{{variables}}`, HTML-escaped.

**Logs** list every email the brand sent or tried to, by kind and status: open one for its events (queued, sent, delivered, opened, clicked, bounced…) and what it said.

## Tracking

Opens are counted from a tiny image and clicks through this server, in campaigns and automations, when the brand counts them; links are signed, so the redirect can't be misused. Opens are a rough measure: Apple Mail loads images for everyone (more opens), and other apps block them (fewer). Each open and click also fills in its contact (see [Insights](#insights)). Transactional email from the API is never tracked, so its links go straight where they say.

## What's kept

- **Bodies** of transactional and automation emails, for the logs: 30 days.
- **Messages and their events:** 365 days.

Both settings are on Email's Settings page (Integrations → Email → Settings). Provider passwords, SES keys and DKIM keys are encrypted in Email's database under a key made from its admin token, and links in emails are signed.

## Updates, backups and removing it

- **Updates** come from the Self Host Layer catalog, as for every integration: **Update** on Integrations and on its Settings page backs it up first when backups are on, then starts the new version beside the old one. Emails already queued go out from the new one.
- **Backups** include `data/email.db`, checked, like your apps' SQLite files.
- **Deleting a brand** (its Settings page) deletes everything in it. **Uninstall** (Email's Settings page) removes Email itself; its `data/` folder is kept in `/var/lib/layer-agent/archive/` unless you say otherwise.

## On the server

```sh
layer logs email                            # its log
sqlite3 /srv/apps/email/data/email.db       # its database (as root)
```

Email listens on `127.0.0.1` only; Caddy brings the API, unsubscribes and clicks to it. The panel manages it through Email's admin API, which answers only requests made on the server with the token made at install.
