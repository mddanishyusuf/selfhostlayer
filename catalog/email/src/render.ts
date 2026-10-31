// What a message says, for one recipient:
//   merge tags   {{name}}, {{first_name}}, {{email}}, {{fields.plan}} (or
//                {{plan}}), {{data.x}} from an event, a template's variables,
//                {{unsubscribe_url}}; {{first_name|there}} for a fallback.
//                HTML-escaped in HTML, as they are in text and subjects.
//   tracking     links through /t/c/… (signed, so it's no open redirect) and
//                a pixel for opens, in campaigns and automations only:
//                transactional mail goes as written.
//   unsubscribe  a footer with the brand's address when the email has no
//                {{unsubscribe_url}} of its own.
//   text         from the HTML when there's none.

const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITY[c]!);

export type Vars = Record<string, unknown>;

/** Looks a tag up: a.b.c through nested objects; contact fields also answer by their own name. */
function lookup(vars: Vars, path: string): string | undefined {
  let v: unknown = vars;
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  if (v === undefined && !path.includes(".") && typeof vars.fields === "object" && vars.fields) v = (vars.fields as Record<string, unknown>)[path];
  return v === undefined || v === null || typeof v === "object" ? undefined : String(v);
}

/** Fills in {{tags}}; `html` escapes values. An unknown tag without a fallback becomes empty. */
export function merge(template: string, vars: Vars, html: boolean): string {
  return template.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_m, path: string, fallback?: string) => {
    const v = lookup(vars, path) ?? fallback ?? "";
    // URLs the email itself carries (unsubscribe) are ours: already safe in an attribute.
    return html && path !== "unsubscribe_url" ? escapeHtml(v) : v;
  });
}

/** A contact's tags: their name, its parts, email and fields. */
export function contactVars(c: { email: string; name: string; fields: Record<string, string> }): Vars {
  const [first = "", ...rest] = c.name.trim().split(/\s+/);
  return { email: c.email, name: c.name, first_name: first, last_name: rest.join(" "), fields: c.fields };
}

/** Text from HTML: paragraphs and line breaks kept, links as "text (url)", the rest of the markup gone. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return !label || label === href ? href : href.startsWith("mailto:") || href.startsWith("#") ? label : `${label} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m]!)
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Puts `html` just before </body>, or at the end. */
function beforeBodyEnd(doc: string, html: string): string {
  const at = doc.search(/<\/body>/i);
  return at < 0 ? doc + html : doc.slice(0, at) + html + doc.slice(at);
}

/** The preheader: the line inboxes show after the subject, hidden in the email itself. */
export function withPreheader(doc: string, preheader: string): string {
  if (!preheader) return doc;
  const span = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(preheader)}${"&#847;&zwnj;&nbsp;".repeat(30)}</div>`;
  const at = doc.search(/<body\b[^>]*>/i);
  if (at < 0) return span + doc;
  const end = doc.indexOf(">", at) + 1;
  return doc.slice(0, end) + span + doc.slice(end);
}

/** A plain footer, for marketing email that has no unsubscribe link of its own. */
export function footer(o: { brand: string; address: string; unsubscribeUrl: string }): { html: string; text: string } {
  const addr = o.address.trim();
  return {
    html: `<div style="margin:32px auto 0;max-width:560px;padding:16px;border-top:1px solid #e5e5e5;color:#8a8a8a;font:12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;text-align:center">${escapeHtml(o.brand)}${addr ? `<br>${escapeHtml(addr).replace(/\n/g, "<br>")}` : ""}<br><a href="${o.unsubscribeUrl}" style="color:#8a8a8a">Unsubscribe</a></div>`,
    text: `\n\n--\n${o.brand}${addr ? `\n${addr}` : ""}\nUnsubscribe: ${o.unsubscribeUrl}`,
  };
}

/** Links through the click tracker, except mailto:, tel:, anchors and the unsubscribe link. */
export function trackLinks(html: string, wrap: (url: string) => string, skip: (url: string) => boolean): string {
  return html.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi, (m, pre: string, q: string, href: string) => {
    const url = href.replace(/&amp;/g, "&").trim();
    if (!/^https?:\/\//i.test(url) || skip(url)) return m;
    return `${pre}${q}${escapeHtml(wrap(url))}${q}`;
  });
}

/** The open pixel. */
export const openPixel = (url: string) => `<img src="${escapeHtml(url)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

/**
 * A marketing email (campaign or automation) for one contact: merged,
 * preheader, footer if needed, tracked when the brand tracks.
 */
export function renderMarketing(o: {
  subject: string;
  html: string;
  text: string;
  preheader: string;
  vars: Vars;
  brand: { name: string; address: string; trackOpens: boolean; trackClicks: boolean };
  unsubscribeUrl: string;
  openUrl: string;
  clickUrl: (url: string) => string;
}): Rendered {
  const vars = { ...o.vars, brand: o.brand.name, unsubscribe_url: o.unsubscribeUrl };
  let html = merge(o.html, vars, true);
  let text = o.text ? merge(o.text, vars, false) : "";
  const hasOwnLink = /\{\{\s*unsubscribe_url\s*\}\}/.test(o.html);
  if (!hasOwnLink) {
    const f = footer({ brand: o.brand.name, address: o.brand.address, unsubscribeUrl: o.unsubscribeUrl });
    html = beforeBodyEnd(html, f.html);
    if (text) text += f.text;
  }
  if (!text) text = htmlToText(html);
  html = withPreheader(html, merge(o.preheader, vars, false));
  if (o.brand.trackClicks) html = trackLinks(html, o.clickUrl, (url) => url === o.unsubscribeUrl);
  if (o.brand.trackOpens) html = beforeBodyEnd(html, openPixel(o.openUrl));
  return { subject: merge(o.subject, vars, false), html, text };
}
