// The few pages a visitor can see: a missing or expired link, the bare
// domain, and a password form. Plain HTML that follows the system's light or
// dark mode, with nothing loaded from elsewhere.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#666;--line:#e5e5e5;--accent:#4f74f8}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e0e;--fg:#ececec;--muted:#9a9a9a;--line:#2a2a2a}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(380px,calc(100vw - 32px))}h1{font-size:20px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}.err{color:#e5484d}
form{display:grid;gap:10px}input{font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:2px;background:transparent;color:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}button{font:inherit;font-weight:600;padding:9px 11px;border:0;border-radius:2px;background:var(--accent);color:#fff;cursor:pointer}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>\n`;
}

export const notFoundPage = () => page("Not found", "<h1>Not found</h1><p>This short link doesn't exist.</p>");

export const gonePage = () => page("Link not active", "<h1>This link isn't active</h1><p>It was turned off or has expired.</p>");

export const homePage = () => page("Short links", "<h1>Short links</h1><p>This domain serves short links.</p>");

export const passwordPage = (error?: string) =>
  page(
    "Password needed",
    `<h1>This link needs a password</h1>${error ? `<p class="err">${esc(error)}</p>` : "<p>Enter it to continue.</p>"}<form method="post"><input type="password" name="password" aria-label="Password" placeholder="Password" required autofocus><button>Continue</button></form>`,
  );
