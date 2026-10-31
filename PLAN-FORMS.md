# Forms: a Typeform and Tally alternative on your own server (asked 2026-10-31)

> The fourth integration: forms people fill in on your own address, with no account, no limits and no data leaving the server. Built fresh for Self Host Layer, Node + SQLite, no runtime dependencies (esbuild bundles it). Its own area in the panel, like Analytics and Email.

## What it does

- **A builder in the panel.** Fields in order, each with its own settings, and a live preview. The fields:
  - short and long text, email, number, URL, phone;
  - one choice (radio), several choices (checkboxes), a dropdown;
  - yes or no, a rating (1 to 5 or 10), a scale (0 to 10, as NPS), a date;
  - a file upload (up to 10 MB);
  - text with no answer (a heading, a paragraph);
  - a hidden field filled from the link (`?ref=newsletter`);
  - a page break.
- **Two layouts:**
  - **classic**, like Tally: the fields on a page, with page breaks for steps;
  - **conversational**, like Typeform: one question at a time, Enter to go on, a progress bar.
- **Logic:** a field shows only when an earlier answer is, isn't, contains, is over or under something, or was answered at all. Hidden fields aren't required, and their answers are dropped.
- **Theming:** an accent color, light or dark, a logo and a button's words. The thank-you screen says what you write, or goes to a link.
- **Sharing:**
  - a link on Forms' address (`/f/<slug>`, the slug yours to choose);
  - an embed that fits its height (`/embed.js`, inline or as a popup button);
  - a link with `?email=…` filling a field in.
- **Responses:**
  - a table, searchable, with each response opened whole; files downloaded through the panel;
  - CSV export; deleting one or all;
  - each response keeps when it came, how long it took, the country (DB-IP, no address kept) and the device.
- **Insights:**
  - views, starts and completions, the completion rate and the average time;
  - for each question, its answers: choices counted, ratings averaged, the NPS score.
- **Notifications:**
  - a webhook per form (JSON, signed `X-Forms-Signature: sha256=…`, tried 3 times);
  - an email to you on each response, and a copy to the respondent, sent through the Email integration when it's installed: the panel connects them with a brand and an API key of Email's.
- **Spam:** a hidden honeypot field, a signed start time (anything sent in under 2 seconds is refused), and at most 10 responses a minute from one address.
- **Closing:** by hand, at a date, or after a number of responses, with a message of your own.

## Decisions

1. **App id `forms`, name Forms,** in the catalog like the others: a `FORMS_ADMIN_TOKEN` admin API on 127.0.0.1, SQLite at `data/forms.db`, and files in `data/uploads/`. Backups take `data/`.
2. **The public form is rendered by a small script of its own** (vanilla JS from the form's schema, inline on the page with a strict CSP), the same for both layouts. Answers go as JSON, files in base64, checked again on the server: required answers, formats, choices, sizes, logic.
3. **Forms' address** (the free URL or a custom domain) serves:
   - `/f/<slug>`;
   - `/f/<slug>/submit`;
   - `/f/<slug>/view` and `/f/<slug>/start`: beacons for views and starts;
   - `/embed.js`.

   The panel tells the app its address on every admin call (`X-Public-Url`), as for Email.
4. **Notifications by email go through Email's API,** so Forms needs no SMTP settings of its own. The panel stores Email's address, a key it makes, the From and the brand in Forms' settings (the key encrypted).
5. **The panel's Forms area** (`/forms/<id>/…`): the sidebar shrinks to its icons, and Forms' sidebar holds a form picker and these pages:
   - Build (the builder);
   - Share (link, embed, QR code);
   - Responses;
   - Insights;
   - Settings (closing, notifications, webhook, deleting).

   `/forms` lists the forms, with New form.

## Days

1. **The service:** forms and their schema (checked), the public page and its script (both layouts, logic, themes), submissions with spam checks, files.
2. **Responses** (list, one, CSV, delete); insights; webhooks; email notifications through Email.
3. **The panel:** the Forms area, the builder, Share, Responses, Insights, Settings.
4. **Tests, the browser tour, docs,** and the catalog entry.

## Result (2026-11-01)

Built as planned, as **Forms 0.1.0** (`catalog/forms`) and the panel's Forms area.

**The service:**
- 17 kinds of question, checked as a schema; logic that may only look back.
- The public page renders both layouts from the schema with a script of its own (no framework, a nonce CSP, embeddable anywhere).
- Answers are checked again on the server, and answers to questions hidden by logic are dropped.
- Spam: a honeypot, a signed start time (2 seconds to a day), 10 answers a minute per address and form, bots not kept.
- Files on disk, read back through the admin API only.

**Responses:** search, CSV, insights (views, starts, completion, the median time, a bar per choice, averages and NPS), deleting one or all.

**Notifications:** signed webhooks and emails through Email's API (Forms has no SMTP of its own), tried again after a minute, ten minutes and an hour. Replies to the owner's email go to whoever answered.

**The panel's Forms area:**
- `/forms` lists the forms, with New form from five templates.
- `/forms/<id>/…` has its own sidebar with a form picker: Build, Share, Responses, Insights and Settings.
- The builder previews the real page through a signed `?preview=` that shows a closed form and counts and keeps nothing.
- Share has the link, a QR code and three embed codes.
- Responses opens each one in a side panel, with its files downloaded through the panel.
- Settings connects Forms to one of Email's brands with a key the panel makes.

**Tests:**
- 8 in `catalog/forms/test`: schemas, answers, the page's scripts, and the whole flow over HTTP (spam, files, CSV, insights, closing, the preview token, webhooks and emails).
- **The browser tour** (TOUR_FORMS, with a webhook sink on the box) passes on the VM:
  - install;
  - a form from the Contact template with a choice and a logic question, built in the builder;
  - a webhook and its test;
  - the form filled in as a person, the logic question appearing for its answer;
  - the response in the panel and the CSV;
  - the webhook's signature checked;
  - closing it;
  - uninstall, leaving nothing.

**Not in 0.1.0:**
- Forms emailing through Email on a test VM: there, Forms can't reach Email's `.internal` address with a trusted certificate. The unit tests cover it, with Email's API faked.
- Payments in forms, signatures, and partial answers saved as people go.
- A form's own custom domain (forms share Forms' address).
