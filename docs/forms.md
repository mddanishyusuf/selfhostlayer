# Forms

Forms puts forms and surveys on your own server, like Typeform or Tally: contact forms, feedback surveys, signups and applications. A form is a page of questions or one question at a time, with logic, ratings, file uploads and hidden fields filled in from the link. Share its link or QR code, or embed it on any site. Responses stay on your server; emails go out through the [Email](email.md) integration, and webhooks are signed.

## Install, and your first form

1. **Forms** in the sidebar → **Install**. Forms installs like one of your apps: its own Linux user and sandbox, its own folder, and a free address with HTTPS (`forms.<your apps domain>`). Its forms' links use that address. For your own address (`forms.example.com`), add a domain on its **Domains** page (Integrations → Forms → Manage).
2. **New form** → pick a template, and give it a title:
   - **Blank:** one question.
   - **Contact:** name, email and a message.
   - **Product feedback:** a rating, NPS, then what to improve or what they like, depending on the rating, one question at a time.
   - **Event signup:** who's coming, how many, food, and where they came from (a hidden field).
   - **Job application:** details on one page, a CV upload and links on the next.

   Everything in a template can change afterwards.

The Forms page lists every form with its responses and whether it's open. Opening one shrinks the panel's sidebar to its icons and opens Forms' own sidebar beside it: a form picker at the top (with **New form**), then **Build**, **Share**, **Responses**, **Insights** and **Settings**. On phones, the picker and the pages are a row of tabs above the page.

## Building a form

**Build** has the questions in order on the left: click one for its settings on the right; the arrows move it, and it can be copied or deleted. **Add** puts a new question after the selected one. **Save** keeps the form; the **Preview** below shows the form's page as saved. Answers sent from the preview are never kept, and it shows the form even while it's closed.

The kinds of question:

- **Text:** short text, long text, email, number, link, phone and date. Email, link and phone answers must look like one. Numbers can have a least and a most, and text a longest answer: 1,000 characters for short text and 10,000 for long text unless you set less.
- **Choices:** one choice, several choices, a dropdown, yes or no, a rating (5 or 10 stars), and a scale from 0 to 10 (or the range you set).
- **More:**
  - **File upload:** up to 10 MB a file and 25 MB a response, optionally only some kinds (like `.pdf, image/*`).
  - **Text (no answer):** a heading and words between questions.
  - **Hidden:** an answer taken from the link, like `?ref=newsletter`; people don't see it.
  - **Page break:** in the classic layout, starts the next step.

Each question has its text, a description under it, whether it's required, and an **id**: the name its answers have in the CSV, in webhooks, and in links that fill it in ahead.

### Logic

**Show only when an earlier answer…** shows a question only for some answers to an earlier one: it is, isn't or contains a value, is answered or not, or is more or less than a number. A question can only depend on questions before it. Answers to questions that end up hidden aren't kept, even if someone sends them.

### Design

On **Design**:

- **Layout:**
  - **Classic:** the questions on a page; page breaks make steps.
  - **Conversational:** one question at a time, with Enter to go on and a progress bar.
- The **description** under the title, a **color** for buttons and choices, light or dark, a **logo** (an image's link) and the button's words.
- **After sending:** a thank-you title and message, or a page to go to instead.

## Sharing

**Share** has:

- **The link**, `https://<forms address>/f/<address>`. Answers can be filled in ahead with a question's id in the link (`?email=ada@example.com`), and hidden fields take theirs from it (`?ref=newsletter`).
- **A QR code**, to download as SVG or a 1024px PNG.
- **Codes for your site**, all served from Forms' address:
  - **In the page:** the form as tall as its questions, with `<div data-shl-form="<address>"></div>` and Forms' `embed.js`.
  - **As a popup** from a button, with `data-mode="popup"`.
  - **A plain iframe**, `…/f/<address>?embed=1`, without the script.

## Responses

**Responses** lists them newest first, with the first questions as columns, how long each took and when it came. Search looks through the answers. Opening one shows every answer whole, files to download, and where it came from: the country, the device, the browser and the site that linked to the form. **CSV** downloads them all, a column per question. A response can be deleted from its panel, or all of them with **Delete every response…**.

Files sent with a response are never public: they're downloaded through the panel only, as files (never shown in the browser). They're written to disk as they come in, never held in memory, and Forms takes no more while the disk has less than 5% of it free (at least 1 GB, at most 10 GB).

## Insights

**Insights** shows how the form does since it was made:

- **Views:** people who opened it.
- **Started:** people who answered a question.
- **Responses** and **completion:** responses of those who started.
- **Time to fill in:** the median.
- **Responses a day,** over 7, 30 or 90 days.

Then each question's answers: a bar per choice, rating or scale value with its count and share, the average of numbers, ratings and scales, the NPS of 0 to 10 scales (promoters, 9 and 10, minus detractors, 0 to 6), and the latest text answers.

## Closing a form

On the form's **Settings**:

- **Taking answers** off closes it by hand.
- **Close at** closes it at a time (in your time zone).
- **Close after** closes it after a number of responses.

A closed form shows its message, or "This form isn't taking answers any more", instead of the questions. **Address** changes the form's link (the old link and embeds stop working). **Duplicate** makes a copy with no responses; **Delete the form** deletes it and its responses.

## Notifications

On the form's **Settings**, under **Notifications**:

- **Email me at:** every response, with its answers, to your address; replies go to the respondent when the form asks for their email.
- **Send respondents a copy:** a note that their answers came in, to the address they gave in one of the form's Email questions, with the answers they picked (choices, ratings, numbers, dates). What they typed isn't repeated: anyone can type someone else's address, and the copy goes out in your brand's name. One copy goes to an address a day from a form, and at most 200 a day from a form.
- **Webhook:** each response posted as JSON to your URL. A redirect isn't followed (it counts as a failure): give the address it ends at.

Emails go out through the [Email](email.md) integration: **Sending email** connects Forms to one of Email's brands. It makes an API key for Forms in that brand, and sends as the brand's From address through its SMTP or SES. This is for every form. Forms has no SMTP settings of its own.

Each notification is tried again after a minute, ten minutes and an hour, and the last ones are listed under the form, with why any failed. **Send a test to the webhook** posts a sample now.

The webhook's body:

```json
{
  "form": { "id": 3, "slug": "feedback", "title": "Product feedback" },
  "response": {
    "id": 128,
    "createdAt": "2026-10-31T21:12:05.000Z",
    "answers": { "stars": 4, "nps": 9, "email": "ada@example.com" },
    "fields": [{ "id": "stars", "label": "How would you rate us?", "type": "rating", "value": 4 }],
    "files": []
  }
}
```

It's signed: `X-Forms-Signature: sha256=<hex HMAC-SHA256 of the body, with the form's signing secret>`. The secret is on the form's Settings; **Make a new secret** replaces it. To check it in Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const ok = (body, header, secret) => {
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
};
```

## Spam, bots and privacy

- **No captcha:**
  - a hidden field bots fill in;
  - a signed start time, so answers sent less than 2 seconds or more than a day after the page loaded are refused;
  - at most 10 answers a minute from one address to one form.
- **Bots** (by their User-Agent) are told all went well, and nothing is kept.
- **Checked twice:** every answer is checked again on the server, as the page checks it.
- **No cookies,** and no IP addresses kept. The country comes from DB-IP's free list, looked up on the server. Only the referring site's name is kept, not its whole address.

## Updates, backups and removing it

- **Updates** come from the Self Host Layer catalog, as for every integration: **Update** on Integrations and on its Settings page backs it up first when backups are on, then starts the new version beside the old one.
- **Backups** include `data/forms.db`, checked, like your apps' SQLite files, and the uploaded files in `data/uploads/`.
- **Uninstall** (Integrations → Forms → Manage → Settings) removes Forms itself; its `data/` folder is kept in `/var/lib/layer-agent/archive/` unless you say otherwise.

## On the server

```sh
layer logs forms                            # its log
sqlite3 /srv/apps/forms/data/forms.db       # its database (as root)
ls /srv/apps/forms/data/uploads/            # uploaded files, by form and response
```

Forms listens on `127.0.0.1` only; Caddy brings the forms' pages to it. The panel manages it through Forms' admin API, which answers only requests made on the server with the token made at install.
