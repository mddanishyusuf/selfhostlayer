# Email: newsletters, transactional email and automations on your own SMTP or SES (asked 2026-10-31)

> The third integration after Links and Analytics: an email platform for indie products, built fresh for Self Host Layer (knowledge from maillayer, none of its code or design). No runtime dependencies (esbuild bundles it), Node + SQLite, its own area in the panel like Analytics.

## What it does

- **Brands.** Several products on one install, each with its own name, sending domains, provider, contacts, campaigns, automations, templates and API keys. The panel's Email area has a brand picker, as Analytics has a site picker.
- **Sending providers:** any **SMTP** server (Amazon SES SMTP, Postmark, Brevo, Mailgun, Resend's SMTP, a Postfix), or **Amazon SES** through its API (SESv2, with our own SigV4 signing: no AWS SDK).
- **Domains.** A brand sends from domains it has verified:
  - SMTP: we sign with our own DKIM key (RSA 2048) and show its TXT record.
  - SES: Easy DKIM's three CNAMEs, read back from SES.
  - Both: SPF and DMARC are checked and explained. Checks use public DNS (1.1.1.1, 8.8.8.8) from the server.
- **Contacts.** Each brand has its own contacts:
  - lists, custom fields, and status (subscribed, unsubscribed, bounced, complained);
  - search, add, edit and delete;
  - CSV import (mapping columns) and export;
  - each contact's history.
- **Campaigns** to lists (with lists to leave out):
  - Markdown (rendered by the panel into a clean, responsive template) or full HTML;
  - preview, test send, send now or schedule;
  - a report: sent, delivered, opened, clicked (by link), bounced, complained, unsubscribed.
- **Transactional email API, Resend-compatible:**
  - `POST /emails` and `POST /emails/batch` (also under `/v1/`), `GET /emails/:id`, with the same JSON as Resend, so its SDKs work with a base URL;
  - each brand has API keys (`em_…`, sha256 kept, shown once);
  - templates with `{{variables}}`;
  - logs with each email's events and body (bodies kept 30 days).
- **Automations:**
  - a trigger (a contact joins a list, or an event sent to `POST /events`);
  - steps: wait, send an email, add to a list, remove from a list;
  - each run is seen; a contact who unsubscribes leaves.
- **Tracking:** opens (a pixel) and clicks (signed redirects), each switchable per brand. Apple's Mail Privacy Protection inflates opens; the docs say so.
- **Unsubscribe:** a footer link, plus RFC 8058 one-click (`List-Unsubscribe` and `List-Unsubscribe-Post`), each signed per message.
- **Bounces and complaints:**
  - SMTP: refusals at RCPT (5xx) are hard bounces;
  - SES: SNS notifications to `/webhooks/ses`, with SNS's signature checked. One button sets up the configuration set, SNS topic and subscription.
  - A hard bounce or complaint goes on the brand's suppression list; campaigns skip suppressed addresses and the API refuses them.
- **Reputation guard:** a campaign pauses itself when its hard bounces pass 5% or complaints 0.3% (after 200 sends), as SES would.

## Decisions

1. **App id `email`, name Email,** in the catalog like Links and Analytics: an `EMAIL_ADMIN_TOKEN` admin API on 127.0.0.1, and SQLite at `data/email.db`.
2. **Its public address** (the free URL or a custom domain) serves:
   - tracking `/t/…`;
   - unsubscribe `/u/…`;
   - the API (`/emails`, `/v1/…`, `/contacts`, `/events`);
   - SNS `/webhooks/ses`;
   - a list's subscribe endpoint `/subscribe/<list key>`.

   The panel tells the app this address with every admin call (`X-Public-Url`): the custom domain once live, else the free URL.
3. **Secrets:**
   - provider credentials and DKIM keys are encrypted in the database (AES-256-GCM under a key from the admin token);
   - API keys are only hashes;
   - a separate `EMAIL_SECRET` signs tracking, unsubscribe and confirmation links.
4. **One queue, the `messages` table.** Workers claim rows atomically (`UPDATE … RETURNING`), so the two colors of a deploy never send the same message twice. A crash leaves a claim that expires after 10 minutes: at least once, never lost. Each brand has a rate (emails per second; SES gives each account its own) and up to 3 tries for transient failures (4xx, timeouts, throttling).
5. **SMTP from scratch** (`node:net`/`node:tls`):
   - EHLO; STARTTLS (587) or implicit TLS (465); AUTH PLAIN or LOGIN;
   - one connection reused per brand while a batch lasts;
   - MIME and DKIM (relaxed/relaxed, rsa-sha256) of our own, checked against an independent verifier.
   - Many VPS hosts block port 25 (Hetzner blocks 25 and 465 for new accounts): the docs say to use 587.
6. **Campaign sending:** the audience is turned into queued messages in one transaction (subscribed contacts in the lists, minus excluded lists and suppressions, each address once). Merge tags `{{name}}`, `{{first_name}}`, `{{email}}`, `{{fields.x}}` and `{{unsubscribe_url}}` are filled in per contact, HTML-escaped.
7. **The panel's Email area** (`/email/<brand>/…`): the sidebar shrinks to its icons, as for Analytics, and Email's sidebar holds a brand picker and these pages:
   - Overview, Campaigns, Contacts, Lists, Automations;
   - Transactional (logs, API keys, templates);
   - Domains;
   - Settings (provider, test email, defaults, the address for the footer, tracking).

   Markdown is rendered in the panel (`marked`), so the app only stores and sends HTML.
8. **Public subscribe endpoint** per list, with optional double opt-in (a confirmation email), for the site's own signup forms (and the Forms integration later).

## Days

1. **Service core:** migrations; brands; domains (DKIM keys, DNS checks); providers (SMTP client, SESv2 + SigV4); MIME and DKIM; test sends.
2. **Contacts:** contacts, lists, import and export, suppressions; the subscribe endpoint and double opt-in.
3. **Sending:** the queue and worker, campaigns (audience, render, schedule, reputation guard), tracking, unsubscribe, SES events.
4. **The transactional API** (Resend-compatible), templates, logs; automations.
5. **The panel:** the Email area and its pages.
6. **Tests, the browser tour, docs,** and the catalog entry.
