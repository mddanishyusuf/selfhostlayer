# Email

Email sends your products' email from your own server: newsletters to your lists, transactional email from your apps (receipts, password resets) through an API that works with Resend's SDKs, and automations like a welcome series. It sends through any SMTP provider or Amazon SES, signs with DKIM, and handles unsubscribes, bounces and complaints. One install serves any number of brands.

## Install, and your first brand

1. **Email** in the sidebar → **Install**. Email installs like one of your apps: its own Linux user and sandbox, its own folder, and a free address with HTTPS (`email.<your apps domain>`). Its emails' links (unsubscribe, tracking) and its API use that address; for your own (`mail.example.com`), add one on its **Domains** page.
2. **Add a brand:** your product's name and the address it sends from. Each brand has its own provider, domains, contacts, campaigns, automations, templates and API keys.
3. The brand's **Overview** lists what it still needs before it can send: a provider, a verified domain, a From address on it, and a list.

Opening a brand shrinks the panel's sidebar to its icons and opens Email's own sidebar beside it: a brand picker at the top (with **Add a brand**), then the brand's pages. On phones, the picker and the pages are a row of tabs above the page.

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

**Suppressed** (on Contacts) lists the addresses nothing is sent to, transactional email included: hard bounces, spam complaints, and addresses added by hand.

**Lists** group contacts. Each list has a signup endpoint, `https://<email address>/subscribe/<key>`, which takes a plain HTML form, or JSON with `Accept: application/json`. The Lists page has a form to paste:

- `email` is required; `name` and any other field go on the contact.
- A hidden `_hp` field keeps bots out.
- `redirect` sends the visitor to your thank-you page.
- With **double opt-in**, new signups get an email with a link to confirm first.

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

Opens are counted from a tiny image and clicks through this server, in campaigns and automations, when the brand counts them; links are signed, so the redirect can't be misused. Opens are a rough measure: Apple Mail loads images for everyone (more opens), and other apps block them (fewer). Transactional email from the API is never tracked, so its links go straight where they say.

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
