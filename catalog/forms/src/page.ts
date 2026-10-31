// A form's public page, /f/<slug>: the form's settings and fields as JSON, the
// script that renders them (client.ts), a hidden honeypot field, and a signed
// start time (the token) the answers must come back with. Embeddable from any
// site (frame-ancestors *), with ?embed=1 for no background or border.
// /embed.js puts forms on other sites: inline at their own height, or as a
// popup from a button.
import { CLIENT_CSS, CLIENT_JS } from "./client.ts";
import type { Form } from "./forms.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** JSON that can sit inside <script> without ending it. */
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export const pageHeaders = (nonce: string) => ({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors *`,
  "Referrer-Policy": "strict-origin-when-cross-origin",
});

function shell(o: { title: string; mode: "light" | "dark"; accent: string; embed: boolean; nonce: string; body: string; description?: string }): string {
  return `<!doctype html>
<html lang="en" data-mode="${o.mode}" style="--accent:${o.accent}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title>
${o.description ? `<meta name="description" content="${esc(o.description.slice(0, 200))}">` : ""}<meta property="og:title" content="${esc(o.title)}">
<style>${CLIENT_CSS}</style></head>
<body${o.embed ? ' class="embed"' : ""}>${o.body}</body></html>`;
}

/** The form, ready to fill in. */
export function formPage(f: Form, o: { base: string; token: string; embed: boolean; nonce: string; preview?: boolean }): string {
  const cfg = { slug: f.slug, title: f.title, base: o.base, token: o.token, schema: f.schema, preview: !!o.preview };
  const body = `<div id="app"><main class="card"><h1>${esc(f.title)}</h1><noscript><p>This form needs JavaScript.</p></noscript></main></div>
<div class="hp" aria-hidden="true"><label>Leave this empty <input id="hp" name="website" tabindex="-1" autocomplete="off"></label></div>
<script type="application/json" id="cfg">${safeJson(cfg)}</script>
<script nonce="${o.nonce}">${CLIENT_JS}</script>`;
  return shell({ title: f.title, mode: f.schema.theme.mode, accent: f.schema.theme.accent, embed: o.embed, nonce: o.nonce, body, description: f.schema.description });
}

/** A closed form: its title and message. */
export function closedPage(f: Form, o: { embed: boolean; nonce: string }): string {
  const body = `<div id="app"><main class="card closed"><h1>${esc(f.title)}</h1><p class="muted pre">${esc(f.closedMessage || "This form isn't taking answers any more.")}</p></main></div>`;
  return shell({ title: f.title, mode: f.schema.theme.mode, accent: f.schema.theme.accent, embed: o.embed, nonce: o.nonce, body });
}

/** No such form. */
export function missingPage(nonce: string): string {
  return shell({ title: "Not found", mode: "light", accent: "#4f46e5", embed: false, nonce, body: `<div id="app"><main class="card closed"><h1>No form here</h1><p class="muted">Check the link, or ask whoever sent it.</p></main></div>` });
}

/**
 * /embed.js: <div data-shl-form="slug"></div> becomes the form, as tall as it
 * is; <button data-shl-form="slug" data-mode="popup"> opens it over the page.
 */
export const EMBED_JS = String.raw`(function () {
  var me = document.currentScript, base = me && me.src.replace(/\/embed\.js(\?.*)?$/, "");
  if (!base) return;
  function frame(slug) {
    var f = document.createElement("iframe");
    f.src = base + "/f/" + encodeURIComponent(slug) + "?embed=1";
    f.title = "Form";
    f.setAttribute("data-shl-slug", slug);
    f.style.cssText = "width:100%;border:0;min-height:420px;background:transparent";
    f.setAttribute("allow", "clipboard-write");
    return f;
  }
  function popup(slug) {
    var shade = document.createElement("div");
    shade.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px";
    var box = document.createElement("div");
    box.style.cssText = "position:relative;width:100%;max-width:680px;max-height:90vh;overflow:auto;background:#fff;border-radius:8px";
    var close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.style.cssText = "position:absolute;top:4px;right:8px;z-index:1;border:0;background:none;font-size:28px;line-height:1;cursor:pointer;color:#71717a";
    function shut() { shade.remove(); document.removeEventListener("keydown", key); }
    function key(e) { if (e.key === "Escape") shut(); }
    close.onclick = shut;
    shade.onclick = function (e) { if (e.target === shade) shut(); };
    document.addEventListener("keydown", key);
    box.appendChild(close);
    box.appendChild(frame(slug));
    shade.appendChild(box);
    document.body.appendChild(shade);
  }
  function setup() {
    document.querySelectorAll("[data-shl-form]").forEach(function (el) {
      if (el.getAttribute("data-shl-ready")) return;
      el.setAttribute("data-shl-ready", "1");
      var slug = el.getAttribute("data-shl-form");
      if (el.getAttribute("data-mode") === "popup") el.addEventListener("click", function (e) { e.preventDefault(); popup(slug); });
      else el.appendChild(frame(slug));
    });
  }
  window.addEventListener("message", function (e) {
    if (e.origin !== new URL(base).origin || !e.data || e.data.type !== "shl-form") return;
    document.querySelectorAll('iframe[data-shl-slug="' + e.data.slug + '"]').forEach(function (f) { if (f.contentWindow === e.source) f.style.height = Math.max(200, e.data.height) + "px"; });
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();`;
