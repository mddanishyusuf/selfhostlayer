// Markdown for emails: what the campaign and automation editors write in,
// turned into HTML with inline styles (what email clients understand), inside
// a plain, responsive email with the brand's footer and {{unsubscribe_url}}.
// HTML typed into the Markdown is shown as text: the HTML editor is for HTML.
//   # ## ###          headings
//   **bold** *italic* `code`  [link](url)  ![alt](image url)
//   - item / 1. item  lists        > quote        ---  a line
//   [[Button](url)]   a button, on a line of its own
// {{merge tags}} pass through for Email to fill in.

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Only web links and mail links; anything else (javascript:) becomes nothing. */
const safeUrl = (url: string) => (/^(https?:\/\/|mailto:|\{\{)/i.test(url.trim()) ? url.trim() : "#");

function inline(text: string, accent: string): string {
  let s = esc(text);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => `<img src="${safeUrl(url)}" alt="${alt}" style="max-width:100%;height:auto;border:0;display:block;margin:8px 0">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${safeUrl(url)}" style="color:${accent};text-decoration:underline">${label}</a>`);
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_m, url: string) => `<a href="${url}" style="color:${accent};text-decoration:underline">${url}</a>`);
  s = s.replace(/`([^`]+)`/g, '<code style="font-family:ui-monospace,Menlo,monospace;font-size:14px;background:#f3f3f3;padding:1px 4px">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  return s;
}

/** The body's HTML from Markdown. */
export function markdownToHtml(md: string, accent = "#2563eb"): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const p = `margin:0 0 16px;font:16px/1.6 ${FONT};color:#171717`;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const size = [26, 21, 18][h[1]!.length - 1];
      out.push(`<h${h[1]!.length} style="margin:24px 0 12px;font:700 ${size}px/1.3 ${FONT};color:#171717">${inline(h[2]!, accent)}</h${h[1]!.length}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr style="border:0;border-top:1px solid #e5e5e5;margin:24px 0">');
      i++;
      continue;
    }
    const button = /^\[\[([^\]]+)\]\(([^)\s]+)\)\]\s*$/.exec(line.trim());
    if (button) {
      out.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="background:${accent}"><a href="${safeUrl(button[2]!)}" style="display:inline-block;padding:12px 22px;font:600 16px/1 ${FONT};color:#ffffff;text-decoration:none">${inline(button[1]!, accent)}</a></td></tr></table>`);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push(`<blockquote style="margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid #e5e5e5;color:#525252">${quote.map((q) => inline(q, accent)).join("<br>")}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag} style="margin:0 0 16px;padding-left:24px;font:16px/1.6 ${FONT};color:#171717">${items.map((it) => `<li style="margin:0 0 6px">${inline(it, accent)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|>|\s*([-*+]|\d+[.)])\s|(-{3,}|\*{3,})\s*$|\[\[)/.test(lines[i]!)) para.push(lines[i++]!);
    out.push(`<p style="${p}">${para.map((l) => inline(l, accent)).join("<br>")}</p>`);
  }
  return out.join("\n");
}

/** A whole email around body HTML: a white card on light gray, the brand and its address, and the unsubscribe link. */
export function emailDocument(o: { body: string; title?: string; brand: string; address?: string }): string {
  const addr = (o.address ?? "").trim();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(o.title ?? o.brand)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border:1px solid #e4e4e7"><tr><td style="padding:32px 32px 16px">
${o.body}
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px"><tr><td style="padding:16px 32px;font:12px/1.6 ${FONT};color:#8a8a8a;text-align:center">${esc(o.brand)}${addr ? `<br>${esc(addr).replace(/\n/g, "<br>")}` : ""}<br><a href="{{unsubscribe_url}}" style="color:#8a8a8a;text-decoration:underline">Unsubscribe</a></td></tr></table>
</td></tr></table>
</body></html>`;
}

/** Markdown as a complete email for a brand. */
export const markdownEmail = (md: string, o: { brand: string; address?: string; title?: string }) => emailDocument({ body: markdownToHtml(md), ...o });

const SAMPLE: Record<string, string> = { first_name: "Ada", last_name: "Lovelace", name: "Ada Lovelace", email: "ada@example.com" };

/** An email as a sample contact (Ada Lovelace) would see it, for previews: merge tags filled in, the unsubscribe link inert. */
export function sampleMerge(html: string, brand: string): string {
  return html.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_m, key: string, fallback?: string) => (key === "unsubscribe_url" ? "#" : key === "brand" ? brand : (SAMPLE[key] ?? fallback ?? "")));
}
