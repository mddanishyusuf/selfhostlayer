// Dev-only preview of the panel's pages with sample data, for checking the UI
// without a VM. Uses its own dev folder, so your normal `next dev` data stays
// untouched.
//
//   1. LAYER_DEV_DIR=/tmp/layer-preview LAYER_DEV_DIST=.next-preview LAYER_FAKE_AGENT=1 npx next dev -p 3100
//   2. node scripts/preview.ts /tmp/layer-preview <out-dir> / /deployments /projects/piqo@light /domains@phone
//
// A path can end in @light, @phone, @guest, @<width>x<height> and/or @click:<css selector>.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [devDir, outDir, ...paths] = process.argv.slice(2);
if (!devDir || !outDir || !paths.length) throw new Error("usage: preview.ts <dev-dir> <out-dir> <path>...");
const base = process.env.PREVIEW_URL ?? "http://localhost:3100";
mkdirSync(outDir, { recursive: true });

// The dev server creates the DB (and runs migrations) on its first request.
await fetch(`${base}/login`).catch(() => {
  throw new Error(`no dev server at ${base} (see the comment at the top)`);
});
const db = new DatabaseSync(join(devDir, "panel.db"));
const now = Math.floor(Date.now() / 1000);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A day of minutes and a week of hours of plausible usage, for the charts. */
function seedMetrics() {
  if (db.prepare("SELECT 1 FROM metrics LIMIT 1").get()) return;
  const insert = db.prepare("INSERT OR REPLACE INTO metrics (target, step, at, cpu, memory_mb, disk_mb) VALUES (?, ?, ?, ?, ?, ?)");
  const nowMs = Date.now();
  const wave = (t: number, period: number) => Math.sin((t / period) * 2 * Math.PI);
  for (const [target, cpu, mem] of [["box", 18, 610], ["piqo", 4, 205], ["maillayer", 2, 160]] as const) {
    for (let m = 24 * 60; m >= 0; m--) {
      const at = Math.floor((nowMs - m * 60_000) / 60_000) * 60_000;
      if (target !== "box" && m > 9 * 60 && m < 9 * 60 + 25) continue; // a gap: the app was being redeployed
      const busy = cpu * (1 + 0.6 * wave(at, 86_400_000) + 0.25 * Math.random()) + (m % 180 < 4 ? cpu * 2 : 0);
      insert.run(target, "minute", at, Math.round(busy * 10) / 10, Math.round(mem * (1 + 0.05 * wave(at, 7_200_000)) + Math.random() * 6), m % 15 === 0 ? (target === "box" ? 8_200 : 310) : null);
    }
    for (let h = 7 * 24; h > 0; h--) {
      const at = Math.floor((nowMs - h * 3_600_000) / 3_600_000) * 3_600_000;
      insert.run(target, "hour", at, Math.round(cpu * (1 + 0.5 * wave(at, 86_400_000)) * 10) / 10, Math.round(mem * (1 + 0.08 * wave(at, 3 * 86_400_000))), null);
    }
  }
}

function seed() {
  if (!db.prepare("SELECT 1 FROM users").get()) {
    db.prepare("INSERT INTO users (email, password_hash, totp_secret_enc, created_at) VALUES (?, 'x', 'x', ?)").run("you@example.com", now);
  }
  if (db.prepare("SELECT 1 FROM projects").get()) return;
  const node = (exec: string[], writable: string[] = []) => JSON.stringify({ kind: "node", exec, writablePaths: writable, healthPath: "/" });
  const next = node(["node", "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1"], [".next/cache"]);
  const projects: [string, string, string, string, string, string][] = [
    ["piqo", "piqo", "nextjs", "npm", "22.11.0", next],
    ["maillayer", "maillayer-lite", "nextjs", "yarn", "22.11.0", next],
    ["postscheduler", "postscheduler", "node-server", "npm", "22.11.0", node(["node", "server.js"])],
    ["blogcms", "blogcms", "astro-node", "bun", "24.13.1", node(["node", "dist/server/entry.mjs"])],
    ["picker", "picker", "nextjs", "npm", "22.11.0", next],
    ["landing", "selfhostlayer-site", "vite", "pnpm", "24.13.1", JSON.stringify({ kind: "static", outputDir: "dist", spa: true })],
  ];
  const ids: Record<string, number> = {};
  for (const [slug, repo, fw, pm, nodeV, runtime] of projects) {
    ids[slug] = Number(
      db
        .prepare("INSERT INTO projects (slug, repo_owner, repo_name, branch, framework, package_manager, node_version, runtime, domains, created_at) VALUES (?, 'mddanishyusuf', ?, 'main', ?, ?, ?, ?, ?, ?)")
        .run(slug, repo, fw, pm, nodeV, runtime, JSON.stringify([`${slug}.203-0-113-7.sslip.io`]), now - 86400 * 20).lastInsertRowid,
    );
    db.prepare("INSERT INTO project_domains (project_id, host, role, status, created_at, verified_at) VALUES (?, ?, 'free', 'active', ?, ?)").run(ids[slug], `${slug}.203-0-113-7.sslip.io`, now - 86400 * 20, now - 86400 * 20);
  }
  const steps = JSON.stringify([{ name: "fetch", ms: 700 }, { name: "install", ms: 17200 }, { name: "build", ms: 39400 }, { name: "start", ms: 900 }, { name: "switch", ms: 2100 }]);
  const deploys: [string, string, string, string, string, number, string | null][] = [
    ["piqo", "ready", "Fix chart tooltips on Safari", "5d0e7b3", "push", 5 * 3600, null],
    ["piqo", "ready", "Add realtime visitors widget", "a1c9e42", "push", 720, null],
    ["maillayer", "ready", "Unsubscribe page copy", "0aa91c4", "push", 86400, null],
    ["maillayer", "building", "Campaign scheduler: timezone fix", "7f3b2d1", "push", 40, null],
    ["postscheduler", "ready", "Retry failed LinkedIn posts", "c04e9aa", "push", 3 * 3600, null],
    ["blogcms", "ready", "RSS: include cover images", "19be7c0", "manual", 86400, null],
    ["picker", "ready", "Sync job: batch writes", "a77b0de", "push", 3 * 86400, null],
    ["picker", "failed", "Upgrade to Next 16", "e55a013", "push", 2 * 86400, "Build failed: exit code 1"],
    ["landing", "ready", "Pricing section", "f00ba12", "push", 7 * 86400, null],
  ];
  for (const [slug, status, msg, sha, trigger, ago, error] of deploys) {
    const done = status === "building" ? null : now - ago + 60;
    db.prepare(
      "INSERT INTO deployments (project_id, sha, commit_message, commit_author, trigger, status, color, error, steps, created_at, started_at, finished_at) VALUES (?, ?, ?, 'mddanishyusuf', ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(ids[slug]!, sha.padEnd(40, "0"), msg, trigger, status, slug === "landing" ? "static" : "blue", error, status === "building" ? "[]" : steps, now - ago, now - ago, done);
  }
  const domain = db.prepare("INSERT INTO project_domains (project_id, host, role, redirect_to, status, message, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  domain.run(ids.piqo!, "piqo.app", "primary", null, "active", null, now - 86400 * 9, now - 86400 * 9);
  domain.run(ids.piqo!, "www.piqo.app", "redirect", "piqo.app", "active", null, now - 86400 * 9, now - 86400 * 9);
  domain.run(ids.maillayer!, "maillayer.com", "primary", null, "active", null, now - 86400 * 9, now - 86400 * 9);
  domain.run(ids.picker!, "go.picker.so", "primary", null, "pending", "No A or CNAME record yet.", now - 600, null);
  db.prepare("INSERT INTO alert_incidents (key, title, detail, opened_at) VALUES ('disk', 'Disk 82% full', 'Free some space: old releases and the build cache are the usual suspects.', ?)").run(now - 3 * 3600);
  db.prepare("INSERT INTO alert_incidents (key, title, detail, opened_at, resolved_at) VALUES ('deploy:5', 'Deploy failed: picker', '', ?, ?)").run(now - 3 * 86400, now - 2 * 86400);
  const backup = db.prepare("INSERT INTO backups (kind, project_id, slug, status, trigger, object_key, bytes, contents, error, started_at, finished_at) VALUES (?, ?, ?, ?, 'schedule', ?, ?, ?, ?, ?, ?)");
  const ms = (agoS: number) => (now - agoS) * 1000;
  backup.run("app", ids.piqo!, "piqo", "ok", "k1", 214_000_000, JSON.stringify({ sqlite: [{ path: "piqo.db", bytes: 210_000_000 }] }), null, ms(8 * 3600), ms(8 * 3600 - 41));
  backup.run("app", ids.maillayer!, "maillayer", "ok", "k2", 39_000_000, JSON.stringify({ sqlite: [], postgres: { bytes: 38_000_000 } }), null, ms(8 * 3600), ms(8 * 3600 - 12));
  backup.run("panel", null, "_panel", "ok", "k3", 1_200_000, "{}", null, ms(8 * 3600), ms(8 * 3600 - 1));
  backup.run("app", ids.blogcms!, "blogcms", "failed", null, null, null, "Can't reach R2: timeout after 120s", ms(86400), ms(86400 - 120));
  db.prepare("INSERT INTO project_crons (project_id, name, schedule, command, created_at) VALUES (?, 'aggregate-stats', '0 * * * *', 'node scripts/aggregate.js', ?)").run(ids.piqo!, now - 86400 * 5);
}

function session(): string {
  const file = join(devDir!, "preview-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  const user = db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() as { id: number };
  db.prepare("INSERT INTO sessions (id_hash, user_id, mfa_ok, created_at, expires_at) VALUES (?, ?, 1, ?, ?)").run(sha256(token), user.id, now, now + 86400 * 30);
  writeFileSync(file, token);
  return token;
}

seed();
seedMetrics();
const token = session();

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9800 + Math.floor(Math.random() * 100);
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${join(outDir, ".chrome")}`, "about:blank"], { stdio: "ignore" });
process.on("exit", () => chrome.kill());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let target: { webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l: { type: string; webSocketDebuggerUrl: string }[]) => l.find((t) => t.type === "page")).catch(() => undefined);
}
if (!target) throw new Error("Chrome didn't start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map<number, (v: { result?: unknown; error?: { message: string } }) => void>();
const waiters: ((m: string) => void)[] = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)!(msg);
  if (msg.method) waiters.splice(0).forEach((w) => w(msg.method));
});
async function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  const msg = await new Promise<{ result?: unknown; error?: { message: string } }>((r) => pending.set(id, r));
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}
await send("Page.enable");
await send("Network.setCookie", { name: "layer_session", value: token, domain: "localhost", path: "/" });

for (const spec of paths) {
  const [path, ...opts] = spec.split("@");
  const phone = opts.includes("phone");
  const size = opts.find((o) => /^\d+x\d+$/.test(o));
  const [w, h] = size ? size.split("x").map(Number) : phone ? [390, 844] : [1440, 900];
  await send("Network.setCookie", { name: "layer-theme", value: opts.includes("light") ? "light" : "dark", domain: "localhost", path: "/" });
  // @guest: signed out, for the login and setup pages.
  if (opts.includes("guest")) await send("Network.deleteCookies", { name: "layer_session", domain: "localhost" });
  else await send("Network.setCookie", { name: "layer_session", value: token, domain: "localhost", path: "/" });
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: phone });
  await send("Page.navigate", { url: new URL(path!, base).href });
  await new Promise<void>((r) => {
    const check = (m: string) => (m === "Page.loadEventFired" ? r() : waiters.push(check));
    waiters.push(check);
  });
  await sleep(700);
  // @click:<css selector> clicks something first (a Manage button, the server button…).
  for (const o of opts.filter((x) => x.startsWith("click:"))) {
    await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(o.slice(6))})?.click()` });
    await sleep(900);
  }
  // The dev server's own badge isn't part of the panel.
  await send("Runtime.evaluate", { expression: `document.querySelector("nextjs-portal")?.remove()` });
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const name = spec.replace(/^\//, "").replace(/@click:.*/, "@click").replace(/[^a-z0-9@-]+/gi, "_") || "home";
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`${spec} → ${name}.png`);
}
process.exit(0);
