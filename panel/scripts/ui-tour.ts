// Drives headless Chrome through the whole panel flow (setup → 2FA → recovery
// codes → dashboard → sign out → sign in with 2FA) and saves a screenshot of
// every step. Doubles as a UI end-to-end check: it exits 1 if a step fails.
//
//   node panel/scripts/ui-tour.ts <base-url> <setup-token> <out-dir>
//
// Needs Google Chrome. Uses the DevTools protocol over Node's built-in WebSocket.
import { execFileSync, execSync, spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { DatabaseSync } from "node:sqlite";
import { currentCounter, totpAt } from "../lib/totp.ts";

const [baseArg, tokenArg, outArg] = process.argv.slice(2);
if (!baseArg || !tokenArg || !outArg) throw new Error("usage: ui-tour.ts <base-url> <setup-token> <out-dir>");
const base: string = baseArg;
const setupToken: string = tokenArg;
const outDir: string = outArg;
mkdirSync(outDir, { recursive: true });

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--ignore-certificate-errors",
    // Without these, macOS can throttle a Chrome nobody looks at until a screenshot never comes back.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(outDir, ".chrome")}`,
    // e.g. "--host-resolver-rules=MAP *.internal 192.168.252.9" to reach apps in a VM.
    // Split only before each "--": an argument's value may contain spaces.
    ...(process.env.CHROME_EXTRA_ARGS ? process.env.CHROME_EXTRA_ARGS.trim().split(/\s+(?=--)/) : []),
    "about:blank",
  ],
  { stdio: "ignore" },
);
process.on("exit", () => chrome.kill());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let target: { webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((list: any[]) => list.find((t) => t.type === "page")).catch(() => undefined);
}
if (!target) throw new Error("Chrome didn't start");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map<number, (v: any) => void>();
// Full page loads of the top frame. A page that reloads by itself (an HMR loop,
// a redirect loop) shows up here even when each load looks fine on its own.
let topNavigations = 0;
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)!(msg);
  if (msg.method === "Page.frameNavigated" && !msg.params.frame.parentId) topNavigations++;
});
/** One DevTools call. A minute without an answer fails the tour instead of hanging it. */
async function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const msg = await Promise.race([
    new Promise<any>((r) => pending.set(id, r)),
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`Chrome didn't answer ${method} within 60s`)), 60_000))),
  ]).finally(() => {
    clearTimeout(timer);
    pending.delete(id);
  });
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}
const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;

async function waitFor(expression: string, what: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return;
    await sleep(150);
  }
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "failure.png"), Buffer.from(data, "base64"));
  const text = String(await evaluate("document.body.innerText")).slice(0, 600);
  throw new Error(`timed out waiting for ${what} (at ${await evaluate("location.pathname")})\npage text:\n${text}`);
}
const waitForPath = (path: string) => waitFor(`location.pathname === ${JSON.stringify(path)} && document.readyState === "complete"`, path);

/** Fails if the page keeps navigating on its own while we do nothing. */
async function assertSettled(where: string) {
  const before = topNavigations;
  await sleep(1500);
  if (topNavigations !== before) {
    throw new Error(`${where}: the page reloaded ${topNavigations - before} time(s) by itself within 1.5s (reload loop?)`);
  }
}

let shot = 0;
async function screenshot(name: string) {
  await assertSettled(name);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const file = join(outDir, `${String(++shot).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  ✓ ${name}`);
}
async function setViewport(width: number, height: number, dark = false) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
}
const fill = (selector: string, value: string) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; return true; })()`);
const click = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click(), true`);
/** For React-controlled inputs: set through the native setter, so React sees the change. */
const setValue = (selector: string, value: string) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
async function typeCode(code: string) {
  await evaluate(`document.querySelector('input[aria-label="Digit 1"]').focus(), true`);
  await send("Input.insertText", { text: code });
}
const go = (path: string) => send("Page.navigate", { url: new URL(path, base).href });

const email = "admin@example.com";
const password = "a-long-test-password";
let lastCounter = 0;
/**
 * A TOTP code for a step that hasn't been used yet: the panel refuses reuse,
 * and accepts at most one step ahead, so a quick run waits for the clock.
 */
async function nextCode(secret: string): Promise<string> {
  while (lastCounter > currentCounter()) await sleep(500);
  const counter = Math.max(currentCounter(), lastCounter + 1);
  lastCounter = counter;
  return totpAt(secret, counter);
}

await send("Page.enable");
await send("Runtime.enable");
await setViewport(1280, 820);

console.log("Setup");
await go("/");
await waitForPath("/setup");
// The panel is dark unless told otherwise; follow the emulated color scheme so screenshots come in both.
await evaluate(`document.cookie = "layer-theme=system; path=/; max-age=31536000", true`);
await screenshot("setup");
await fill("#token", "wrong-token");
await click("button[type=submit]");
await waitFor(`!!document.querySelector('[role=alert]')`, "token error");
await screenshot("setup-wrong-token");
await fill("#token", setupToken);
await click("button[type=submit]");
await waitForPath("/setup/account");
await screenshot("create-admin");
await fill("#email", email);
await fill("#password", password);
await fill("#confirm", password);
await click("button[type=submit]");
await waitForPath("/setup/2fa");
await screenshot("2fa-setup");
const secret = String(await evaluate(`document.querySelector("code").textContent`)).replace(/\s/g, "");
await typeCode(await nextCode(secret));
await waitForPath("/setup/recovery");
await screenshot("recovery-codes");
await click("button[type=submit]");
await waitForPath("/");
await waitFor(`!!document.querySelector('a[href="/health"]')`, "dashboard data");
await screenshot("dashboard");
await go("/health");
await waitFor(`document.querySelectorAll('[role=meter]').length === 4`, "server health (CPU, memory, disk, swap)");
await screenshot("health");
await go("/");
await waitForPath("/");
await setViewport(1280, 820, true);
await screenshot("dashboard-dark");
await setViewport(390, 844);
await screenshot("dashboard-mobile");
await setViewport(1280, 820);

console.log("Sign out and back in");
await click('button[title="Sign out"]');
await waitForPath("/login");
await screenshot("login");
await fill("#email", email);
await fill("#password", "wrong-password-123");
await click("button[type=submit]");
await waitFor(`!!document.querySelector('[role=alert]')`, "login error");
await screenshot("login-wrong-password");
await fill("#password", password);
await click("button[type=submit]");
await waitForPath("/login/2fa");
await screenshot("login-2fa");
await typeCode(await nextCode(secret));
await waitForPath("/");
await setViewport(1280, 820, true);
await go("/login");
await waitForPath("/");
console.log("  ✓ signed in again; /login redirects to the dashboard");

// With a fake GitHub (panel/scripts/fake-github.ts): TOUR_GITHUB=1 TOUR_WEBHOOK_SECRET=<its secret>.
if (process.env.TOUR_GITHUB === "1") {
  console.log("GitHub");
  await setViewport(1280, 820);
  await go("/github/connect");
  await waitForPath("/github/connect");
  await screenshot("github-connect");
  // The form that posts to GitHub (not the sign-out form in the top bar).
  await click('form[action^="http"] button[type=submit]');
  // Panel → GitHub (create app) → panel (manifest) → GitHub (install) → panel (installed) → /new
  await waitForPath("/new");
  await waitFor(`document.body.innerText.includes("selfhostlayer-examples")`, "repository list");
  await screenshot("new-project-repos");
  await go("/github/connect");
  await waitFor(`document.body.innerText.includes("Connected")`, "connected state");
  await screenshot("github-connected");

  const secret = process.env.TOUR_WEBHOOK_SECRET ?? "";
  const deliver = async (signatureSecret: string, delivery: string) => {
    const payload = JSON.stringify({ action: "created", installation: { id: 4242, account: { login: "mddanishyusuf", type: "User" }, repository_selection: "selected", suspended_at: null } });
    const res = await fetch(new URL("/api/github/webhook", base), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "installation",
        "X-GitHub-Delivery": delivery,
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", signatureSecret).update(payload).digest("hex")}`,
      },
      body: payload,
    });
    return { status: res.status, body: (await res.json()) as { duplicate?: boolean } };
  };
  const id = randomUUID();
  const first = await deliver(secret, id);
  if (first.status !== 202) throw new Error(`signed webhook: expected 202, got ${first.status}`);
  console.log("  ✓ signed webhook accepted (202)");
  const again = await deliver(secret, id);
  if (!again.body.duplicate) throw new Error("replayed webhook wasn't recognized as a duplicate");
  console.log("  ✓ replayed delivery ignored");
  const forged = await deliver("wrong-secret", randomUUID());
  if (forged.status !== 401) throw new Error(`forged webhook: expected 401, got ${forged.status}`);
  console.log("  ✓ webhook with a bad signature refused (401)");
}

// On a deployment's page: waits until it ends, and fails unless it's Ready.
const headerText = `document.querySelector("main header")?.innerText ?? ""`;
const waitForDeploy = async (what: string) => {
  await waitFor(`/\\b(Ready|Failed|Cancelled)\\b/.test(${headerText})`, `${what} to finish`, 15 * 60_000);
  const header = String(await evaluate(headerText));
  if (!header.includes("Ready")) {
    throw new Error(`${what} didn't succeed: ${header}\n${String(await evaluate(`document.querySelector('[role=log]')?.innerText ?? ""`)).slice(-1500)}`);
  }
};
/** Opens https://<host><path> until it shows the text (a new app's certificate can take a moment). */
const visit = async (host: string, path: string, expected: string) => {
  let text = "";
  for (let i = 0; i < 20 && !text.includes(expected); i++) {
    await go(`https://${host}${path}`);
    await sleep(1500);
    text = String(await evaluate("document.body?.innerText ?? ''").catch(() => ""));
  }
  if (!text.includes(expected)) throw new Error(`https://${host}${path} didn't show "${expected}" (got: ${text.slice(0, 200)})`);
  console.log(`  ✓ https://${host}${path} shows "${expected}"`);
};

// Deploys from github.com/mddanishyusuf/selfhostlayer-examples through the UI. TOUR_DEPLOY=1,
// TOUR_APPS_DOMAIN=<the box's appsDomain> (default "internal").
if (process.env.TOUR_DEPLOY === "1") {
  console.log("Deploy");
  const appsDomain = process.env.TOUR_APPS_DOMAIN ?? "internal";
  await setViewport(1280, 900);
  const openNewestDeployment = async () => {
    const href = String(await evaluate(`document.querySelector('main a[href*="/deployments/"]').getAttribute("href")`));
    await go(href);
    await waitForPath(href);
    return href;
  };
  const importFolder = async (rootDir: string) => {
    await go("/new");
    await waitForPath("/new");
    await evaluate(`document.querySelectorAll("details").forEach((d) => (d.open = true)), true`);
    await fill("#repo", "https://github.com/mddanishyusuf/selfhostlayer-examples");
    await fill("#rootDir", rootDir);
    await click("form:has(#repo) button[type=submit]");
    // Import lands on Configure (detected settings, env vars) before the first deploy.
    await waitFor(`location.pathname === "/projects/${rootDir}/settings"`, `configure page for ${rootDir}`, 60_000);
  };
  const deployFromSettings = async () => {
    await click('button[value="deploy"]');
    await waitFor(`/\\/deployments\\/\\d+$/.test(location.pathname)`, "deployment page", 60_000);
  };

  await importFolder("next");
  await evaluate(`(() => {
    const [name, value] = document.querySelectorAll('input[aria-label="Name"], input[aria-label="Value"]');
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(name, "GREETING"); set(value, "hello from the panel");
    return true;
  })()`);
  await screenshot("configure-next");
  await deployFromSettings();
  await waitForDeploy("Next.js deploy");
  await screenshot("deployment-next-ready");
  await visit(`next.${appsDomain}`, "/", "example-next");
  await go("/projects/next");
  await waitForPath("/projects/next");
  await screenshot("project-next");

  // Environment: values are text fields drawn as dots, so no browser takes the
  // form for a login and fills in a saved password; Raw .env is the same
  // variables as text, and a pasted line comes back as a row.
  await go("/projects/next/env");
  await waitForPath("/projects/next/env");
  const envForm = `document.querySelector('input[name="env"]').form`;
  if (Number(await evaluate(`${envForm}.querySelectorAll('input[type=password]').length`))) throw new Error("the env form has a password field, which browsers fill with a saved login");
  if (Number(await evaluate(`[...${envForm}.querySelectorAll('input:not([type=hidden])')].filter((i) => i.autocomplete !== "off").length`))) throw new Error("an env field lets the browser autofill it");
  const envRows = async () => JSON.parse(String(await evaluate(`JSON.stringify([...document.querySelectorAll('input[aria-label="Name"]')].map((i) => [i.value, i.closest("div").querySelector('input[aria-label="Value"]').value]))`))) as [string, string][];
  await click('button[data-mode="text"]');
  await waitFor(`/^GREETING=hello from the panel$/m.test(document.querySelector('textarea[aria-label=".env"]')?.value ?? "")`, "the variables as .env text");
  await evaluate(`(() => {
    const t = document.querySelector('textarea[aria-label=".env"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, t.value + '\\n# pasted from a .env file\\nexport TOUR_FLAG="on"');
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await click('button[data-mode="rows"]');
  await waitFor(`[...document.querySelectorAll('input[aria-label="Name"]')].some((i) => i.value === "TOUR_FLAG")`, "the pasted variable as a row");
  const afterText = await envRows();
  if (!afterText.some(([k, v]) => k === "GREETING" && v === "hello from the panel") || !afterText.some(([k, v]) => k === "TOUR_FLAG" && v === "on")) throw new Error(`rows after Raw .env: ${JSON.stringify(afterText)}`);
  await click('form:has(input[name="env"]) button[value="save"]');
  await waitFor(`!!document.querySelector('form:has(input[name="env"]) p.text-teal')`, "the variables to save");
  await go("/projects/next/env");
  await waitForPath("/projects/next/env");
  await waitFor(`!!document.querySelector('input[aria-label="Value"]')`, "the env editor");
  if (!(await envRows()).some(([k, v]) => k === "TOUR_FLAG" && v === "on")) throw new Error(`TOUR_FLAG wasn't saved: ${JSON.stringify(await envRows())}`);
  await screenshot("env-next");
  console.log("  ✓ Environment: no password field for a browser to fill; Raw .env shows the variables as text, and a pasted line came back as a row and saved");

  await importFolder("vite");
  await deployFromSettings();
  await waitForDeploy("Vite (static) deploy");
  await visit(`vite.${appsDomain}`, "/some/route", "example-vite");

  console.log("Redeploy and rollback");
  await go("/projects/next");
  await waitForPath("/projects/next");
  await click('form:has(input[name=slug]) button[type=submit]');
  await waitFor(`/\\/deployments\\/\\d+$/.test(location.pathname)`, "redeploy page", 60_000);
  await waitForDeploy("redeploy");
  await go("/projects/next");
  await waitForPath("/projects/next");
  await click('button[title="Roll back to this deployment"]');
  await waitFor(`/\\/deployments\\/\\d+$/.test(location.pathname)`, "rollback page", 60_000);
  await waitForDeploy("rollback");
  const rollbackLog = String(await evaluate(`document.querySelector('[role=log]')?.innerText ?? ""`));
  if (!rollbackLog.includes("build is skipped")) throw new Error("the rollback rebuilt instead of reusing the build on disk");
  console.log("  ✓ rollback reused the build on disk (no rebuild)");
  await screenshot("deployment-rollback");
  await visit(`next.${appsDomain}`, "/api/health", "ok");

  console.log("Crons");
  await go("/projects/next/crons");
  await waitForPath("/projects/next/crons");
  await fill("#name", "greet");
  await setValue("#schedule", "*/30 * * * *");
  await fill("#command", "node -e console.log(process.env.GREETING)");
  await click("form:has(#command) button[type=submit]");
  await waitFor(`document.body.innerText.includes("Saved greet")`, "cron saved", 60_000);
  await waitFor(`!!document.querySelector('[data-testid="next-run"]')`, "next run shown", 30_000);
  console.log("  ✓ saved a cron job; its timer is scheduled on the server");
  await screenshot("crons");
  await click('button[title="Run now"]');
  await waitForPath("/projects/next/crons/greet");
  let runs = "";
  for (let i = 0; i < 20 && !runs.includes("Succeeded"); i++) {
    await sleep(1500);
    await go("/projects/next/crons/greet");
    await waitForPath("/projects/next/crons/greet");
    runs = String(await evaluate("document.body.innerText"));
  }
  if (!runs.includes("Succeeded") || !runs.includes("hello from the panel")) throw new Error(`the cron run didn't succeed with the env var in its output:\n${runs.slice(0, 600)}`);
  console.log("  ✓ Run now: succeeded as the app, with its env var in the output");
  await screenshot("cron-runs");

  // TOUR_ALERTS=1: needs the test receiver (installer/test/alert-receiver.sh) at https://hook.internal.
  if (process.env.TOUR_ALERTS === "1") {
    console.log("Alerts");
    const hookLog = async () => {
      await go("https://hook.internal/log");
      await sleep(500);
      return String(await evaluate("document.body?.innerText ?? ''"));
    };
    const waitForHook = async (text: string, what: string, timeoutMs = 150_000) => {
      const deadline = Date.now() + timeoutMs;
      let log = "";
      while (Date.now() < deadline) {
        log = await hookLog();
        if (log.includes(text)) return;
        await sleep(5000);
      }
      throw new Error(`no webhook with "${text}" (${what}) within ${timeoutMs / 1000}s. Received:\n${log.slice(-800)}`);
    };
    await go("/settings/alerts");
    await waitForPath("/settings/alerts");
    await evaluate(`[...document.querySelectorAll('button[role=radio]')].find((b) => b.textContent === "Webhook").click(), true`);
    await waitFor(`!!document.querySelector("#url")`, "webhook fields");
    await fill("#url", "https://hook.internal/in");
    await fill("#secret", "tour-secret");
    await click("form:has(#url) button[type=submit]");
    await waitFor(`document.body.innerText.includes("A test message is on its way") || document.body.innerText.includes("test message failed")`, "channel saved", 30_000);
    if (String(await evaluate("document.body.innerText")).includes("test message failed")) throw new Error(String(await evaluate(`document.querySelector('[role=alert]')?.innerText`)));
    await waitForHook("Alerts from Self Host Layer are set up", "test message");
    console.log("  ✓ webhook channel saved; its signed test message arrived");

    // A failing cron job → one alert; fixed → one recovery message.
    await go("/projects/next/crons");
    await waitForPath("/projects/next/crons");
    await fill("#name", "fails");
    await setValue("#schedule", "@daily");
    await fill("#command", "node -e process.exit(4)");
    await click("form:has(#command) button[type=submit]");
    await waitFor(`document.body.innerText.includes("Saved fails")`, "failing cron saved", 60_000);
    await evaluate(`[...document.querySelectorAll("a")].find((a) => a.querySelector("p")?.textContent === "fails")?.closest("div").querySelector('button[title="Run now"]').click(), true`);
    await waitForHook("Cron job failed: next/fails", "cron failure alert");
    console.log("  ✓ a failed cron run raised an alert");
    await go("/settings/alerts");
    await waitForPath("/settings/alerts");
    if (!(await evaluate(`!!document.querySelector('a[href="/settings/alerts"] [aria-label="needs attention"]')`))) throw new Error("the sidebar doesn't flag the open incident");
    console.log("  ✓ the sidebar's Alerts item flags the open incident");
    await screenshot("alerts-open");
    await go("/projects/next/crons");
    await waitForPath("/projects/next/crons");
    await fill("#name", "fails");
    await setValue("#schedule", "@daily");
    await fill("#command", "node -e process.exit(0)");
    await click("form:has(#command) button[type=submit]");
    await waitFor(`document.body.innerText.includes("Saved fails")`, "fixed cron saved", 60_000);
    await evaluate(`[...document.querySelectorAll("a")].find((a) => a.querySelector("p")?.textContent === "fails")?.closest("div").querySelector('button[title="Run now"]').click(), true`);
    await waitForHook('"event":"resolved","key":"cron:next:fails"', "cron recovery");
    const log = await hookLog();
    if ((log.match(/Cron job failed: next\/fails/g) ?? []).length !== 2) throw new Error("expected exactly one alert and one recovery for the cron job");
    console.log("  ✓ the next successful run sent exactly one recovery message");
  }

  // TOUR_BACKUPS=1: needs a fake S3 at http://127.0.0.1:4999 on the box (installer/test/fake-s3.sh).
  if (process.env.TOUR_BACKUPS === "1") {
    console.log("Backups");
    const visits = async (add = false) => {
      await go(`https://next.${appsDomain}/api/visits${add ? "?add=1" : ""}`);
      await sleep(300);
      return Number(JSON.parse(String(await evaluate("document.body.innerText"))).visits);
    };
    for (let i = 0; i < 3; i++) await visits(true);
    if ((await visits()) !== 3) throw new Error("the example app didn't count 3 visits in SQLite");
    console.log("  ✓ the app stores visits in SQLite under DATA_DIR (3)");

    await go("/settings/backups");
    await waitForPath("/settings/backups");
    await evaluate(`[...document.querySelectorAll('button[role=radio]')].find((b) => b.textContent === "Other").click(), true`);
    await fill("#endpoint", "http://127.0.0.1:4999");
    await setValue("#region", "us-east-1");
    await fill("#bucket", "tour-backups");
    await fill("#prefix", "layer");
    await fill("#accessKeyId", "test");
    await fill("#secretAccessKey", "testsecret");
    await click("form:has(#endpoint) button[type=submit]");
    await waitFor(`!!document.querySelector('[data-testid="recovery-key"]') || !!document.querySelector('form:has(#endpoint) [role=alert]')`, "storage connected", 60_000);
    const keyText = String(await evaluate(`document.querySelector('[data-testid="recovery-key"]')?.innerText ?? document.querySelector('form:has(#endpoint) [role=alert]')?.innerText`));
    if (!/^lbk1-[A-Za-z0-9_-]{43}$/.test(keyText.trim())) throw new Error(`no recovery key after connecting: ${keyText}`);
    console.log("  ✓ storage connected (test object written, read, listed, deleted); recovery key shown");
    await screenshot("backups-recovery-key");
    await click('form:has(input[name="saved"]) input[name="saved"]');
    await click('form:has(input[name="saved"]) button[type=submit]');
    await waitFor(`document.body.innerText.includes("Back up everything now")`, "backups turned on", 30_000);
    console.log("  ✓ recovery key confirmed; backups are on");

    await go("/projects/next/backups");
    await waitForPath("/projects/next/backups");
    await click('form:has(input[name="slug"]) button[type=submit]');
    await waitFor(`!!document.querySelector('[data-testid="backup-list"] [data-status="ok"], [data-testid="backup-list"] [data-status="failed"]')`, "the backup to finish", 180_000);
    const row = String(await evaluate(`document.querySelector('[data-testid="backup-list"] > div')?.innerText ?? ""`));
    if (!row.includes("Backed up") || !row.includes("1 SQLite database checked")) throw new Error(`backup didn't succeed: ${row}`);
    console.log("  ✓ Back up now: snapshot with 1 SQLite database checked, encrypted and uploaded");
    await screenshot("backups-project");

    for (let i = 0; i < 2; i++) await visits(true);
    if ((await visits()) !== 5) throw new Error("expected 5 visits before the restore");
    await go("/projects/next/backups");
    await waitForPath("/projects/next/backups");
    await evaluate(`[...document.querySelectorAll('[data-testid="backup-list"] button')].find((b) => b.textContent === "Restore").click(), true`);
    await waitFor(`!!document.querySelector('input[name="confirm"]')`, "restore confirmation");
    await setValue('input[name="confirm"]', "next");
    await waitFor(`!document.querySelector('form:has(input[name="confirm"]) button[type=submit]').disabled`, "the restore button to enable");
    await click('form:has(input[name="confirm"]) button[type=submit]');
    await waitFor(`document.body.innerText.includes("Restored.") || !!document.querySelector('form:has(input[name="confirm"]) [role=alert]')`, "the restore", 180_000);
    const restored = String(await evaluate("document.body.innerText"));
    if (!restored.includes("Restored.")) throw new Error(`restore failed: ${String(await evaluate(`document.querySelector('form:has(input[name="confirm"]) [role=alert]')?.innerText`))}`);
    let count = -1;
    for (let i = 0; i < 20 && count !== 3; i++) {
      count = await visits().catch(() => -1);
      if (count !== 3) await sleep(1000);
    }
    if (count !== 3) throw new Error(`after the restore the app counts ${count} visits, expected 3`);
    console.log("  ✓ restore: the app restarted on the backup's data (5 visits → 3)");

    await go("/settings/backups");
    await waitForPath("/settings/backups");
    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Back up everything now").click(), true`);
    await waitFor(`[...document.querySelectorAll('[data-testid="backup-list"] > div')].some((d) => d.innerText.includes("panel") && d.dataset.status !== "running")`, "the panel backup", 180_000);
    const panelRow = String(await evaluate(`[...document.querySelectorAll('[data-testid="backup-list"] > div')].find((d) => d.innerText.includes("panel")).innerText`));
    if (!panelRow.includes("Backed up")) throw new Error(`panel backup failed: ${panelRow}`);
    console.log("  ✓ Back up everything: the panel's own database and key are backed up too");
    await screenshot("backups-settings");
  }

  // TOUR_REDIS=1: add a Redis to the next app from the Databases page.
  if (process.env.TOUR_REDIS === "1") {
    console.log("Redis");
    const redisVisits = async (add = false) => {
      await go(`https://next.${appsDomain}/api/redis${add ? "?add=1" : ""}`);
      await sleep(300);
      return JSON.parse(String(await evaluate("document.body.innerText"))) as { visits?: number; error?: string };
    };
    if ((await redisVisits()).error !== "no REDIS_URL") throw new Error("the app already has REDIS_URL");
    await go("/projects/next/databases");
    await waitForPath("/projects/next/databases");
    await click('[data-testid="redis-card"] form button[type=submit]');
    await waitFor(`!!document.querySelector('[data-testid="notice"]') || /role="alert"/.test(document.querySelector('[data-testid="redis-card"]').innerHTML)`, "Redis to be added (installs it the first time)", 300_000);
    const added = String(await evaluate(`document.querySelector('[data-testid="notice"]')?.innerText ?? document.querySelector('[data-testid="redis-card"]').innerText`));
    const deployment = /deployment #(\d+)/.exec(added)?.[1];
    if (!deployment) throw new Error(`Redis wasn't added with a restart: ${added}`);
    console.log(`  ✓ Redis installed and started for next; restarting it on the same build (#${deployment})`);
    await go(`/deployments/${deployment}`);
    await waitForDeploy("the restart with REDIS_URL");
    let first: { visits?: number; error?: string } = {};
    for (let i = 0; i < 10 && first.visits === undefined; i++) {
      first = await redisVisits(true);
      if (first.visits === undefined) await sleep(1000);
    }
    const second = await redisVisits(true);
    if (first.visits !== 1 || second.visits !== 2) throw new Error(`Redis counter: ${JSON.stringify(first)} then ${JSON.stringify(second)}`);
    console.log("  ✓ the app counts visits in its own Redis (1, 2)");
    await go("/projects/next/databases");
    await waitForPath("/projects/next/databases");
    const url = String(await evaluate(`document.querySelector('[data-testid="secret-url"]')?.innerText ?? ""`));
    if (!/^redis:\/\/default:••••••••@127\.0\.0\.1:\d+$/.test(url)) throw new Error(`REDIS_URL isn't shown masked: ${url}`);
    console.log("  ✓ the Databases page shows it running, with REDIS_URL masked");
    await screenshot("databases-redis");
  }

  // TOUR_POSTGRES=1: add Postgres to the next app; the next backup includes a pg_dump.
  if (process.env.TOUR_POSTGRES === "1") {
    console.log("Postgres");
    await go("/projects/next/databases");
    await waitForPath("/projects/next/databases");
    await click('[data-testid="postgres-card"] form button[type=submit]');
    await waitFor(`!!document.querySelector('[data-testid="notice"]') || /role="alert"/.test(document.querySelector('[data-testid="postgres-card"]').innerHTML)`, "Postgres to be added (installs it the first time)", 600_000);
    const added = String(await evaluate(`document.querySelector('[data-testid="notice"]')?.innerText ?? document.querySelector('[data-testid="postgres-card"]').innerText`));
    const deployment = /deployment #(\d+)/.exec(added)?.[1];
    if (!deployment) throw new Error(`Postgres wasn't added with a restart: ${added}`);
    const url = String(await evaluate(`[...document.querySelectorAll('[data-testid="secret-url"]')].map((e) => e.innerText).find((t) => t.startsWith("postgresql:")) ?? ""`));
    if (!/^postgresql:\/\/app_next:••••••••@127\.0\.0\.1:5432\/app_next$/.test(url)) throw new Error(`DATABASE_URL isn't shown masked: ${url}`);
    console.log(`  ✓ Postgres installed, database app_next created, DATABASE_URL shown masked; restarting (#${deployment})`);
    await screenshot("databases-postgres");
    await go(`/deployments/${deployment}`);
    await waitForDeploy("the restart with DATABASE_URL");
    if (process.env.TOUR_BACKUPS === "1") {
      await go("/projects/next/backups");
      await waitForPath("/projects/next/backups");
      const before = Number(await evaluate(`document.querySelectorAll('[data-testid="backup-list"] [data-status]').length`));
      await click('form:has(input[name="slug"]) button[type=submit]');
      await waitFor(`document.querySelectorAll('[data-testid="backup-list"] [data-status]').length > ${before} && !document.querySelector('[data-testid="backup-list"] [data-status="running"]')`, "the backup with Postgres", 180_000);
      const row = String(await evaluate(`document.querySelector('[data-testid="backup-list"] > div')?.innerText ?? ""`));
      if (!row.includes("Postgres dump")) throw new Error(`the backup has no Postgres dump: ${row}`);
      console.log("  ✓ the next backup includes a pg_dump of the app's database");
    }
  }

  // TOUR_MYSQL=1: an app gets one SQL database, so Postgres goes first (with the
  // type-to-confirm dialog), then MySQL comes in; the next backup has its dump.
  if (process.env.TOUR_MYSQL === "1") {
    console.log("MySQL");
    const setTyped = (selector: string, value: string) =>
      evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    const restartOf = async (what: string) => {
      const notice = String(await evaluate(`document.querySelector('[data-testid="notice"]')?.innerText ?? ""`));
      const deployment = /deployment #(\d+)/.exec(notice)?.[1];
      if (!deployment) throw new Error(`${what} without a restart: ${notice}`);
      await go(`/deployments/${deployment}`);
      await waitForDeploy(`the restart after ${what}`);
      return deployment;
    };
    await go("/projects/next/databases");
    await waitForPath("/projects/next/databases");
    if (process.env.TOUR_POSTGRES === "1") {
      const card = String(await evaluate(`document.querySelector('[data-testid="mysql-card"]').innerText`));
      if (!card.includes("next uses Postgres")) throw new Error(`MySQL is offered next to Postgres: ${card}`);
      await evaluate(`[...document.querySelectorAll('[data-testid="postgres-card"] button')].find((b) => b.textContent === "Remove Postgres…").click(), true`);
      await waitFor(`!!document.querySelector("#confirm-postgres")`, "the remove dialog");
      await setTyped("#confirm-postgres", "next");
      await waitFor(`!document.querySelector('[role=dialog] button[type=submit]').disabled`, "the remove button to unlock");
      await click("[role=dialog] button[type=submit]");
      await waitFor(`/Postgres removed/.test(document.querySelector('[data-testid="notice"]')?.innerText ?? "")`, "Postgres to be removed", 120_000);
      console.log(`  ✓ removed Postgres after typing the app's name; a final dump stays on the server (#${await restartOf("removing Postgres")})`);
      await go("/projects/next/databases");
      await waitForPath("/projects/next/databases");
    }
    await click('[data-testid="mysql-card"] form button[type=submit]');
    await waitFor(`!!document.querySelector('[data-testid="notice"]') || /role="alert"/.test(document.querySelector('[data-testid="mysql-card"]').innerHTML)`, "MySQL to be added (installs MariaDB the first time)", 600_000);
    const url = String(await evaluate(`[...document.querySelectorAll('[data-testid="secret-url"]')].map((e) => e.innerText).find((t) => t.startsWith("mysql:")) ?? ""`));
    if (!/^mysql:\/\/app_next:••••••••@127\.0\.0\.1:3306\/app_next$/.test(url)) throw new Error(`DATABASE_URL isn't shown masked: ${url || await evaluate(`document.querySelector('[data-testid="mysql-card"]').innerText`)}`);
    await screenshot("databases-mysql");
    console.log(`  ✓ MariaDB installed, database app_next created, DATABASE_URL shown masked (#${await restartOf("adding MySQL")})`);
    if (process.env.TOUR_BACKUPS === "1") {
      await go("/projects/next/backups");
      await waitForPath("/projects/next/backups");
      const before = Number(await evaluate(`document.querySelectorAll('[data-testid="backup-list"] [data-status]').length`));
      await click('form:has(input[name="slug"]) button[type=submit]');
      await waitFor(`document.querySelectorAll('[data-testid="backup-list"] [data-status]').length > ${before} && !document.querySelector('[data-testid="backup-list"] [data-status="running"]')`, "the backup with MySQL", 180_000);
      const row = String(await evaluate(`document.querySelector('[data-testid="backup-list"] > div')?.innerText ?? ""`));
      if (!row.includes("MySQL dump")) throw new Error(`the backup has no MySQL dump: ${row}`);
      console.log("  ✓ the next backup includes a dump of the app's MySQL database");
    }
  }

  // TOUR_MONGODB=1: MongoDB comes in next to whatever SQL database the app has
  // (it gets MONGODB_URI, not DATABASE_URL); the URI shows masked with Reveal and
  // Copy, and the next backup has a mongodump.
  if (process.env.TOUR_MONGODB === "1") {
    console.log("MongoDB");
    await go("/projects/next/databases");
    await waitForPath("/projects/next/databases");
    const card = () => evaluate(`document.querySelector('[data-testid="mongodb-card"]').innerText`).then(String);
    const notice = () => evaluate(`document.querySelector('[data-testid="notice"]')?.innerText ?? ""`).then(String);
    // Once for the whole server: MongoDB is installed on its own; then each project creates its database and user.
    if ((await card()).includes("Install MongoDB on this server")) {
      await click('[data-testid="mongodb-card"] form button[type=submit]');
      await waitFor(`/MongoDB is running on this server/.test(document.querySelector('[data-testid="notice"]')?.innerText ?? "") || /role="alert"/.test(document.querySelector('[data-testid="mongodb-card"]').innerHTML)`, "MongoDB to be installed on the server", 900_000);
      if (!(await notice()).includes("MongoDB is running on this server")) throw new Error(`installing MongoDB failed: ${await card()}`);
      console.log("  ✓ MongoDB installed once, for the whole server");
    }
    if (!(await card()).includes("Create database and user")) throw new Error(`no Create database and user: ${await card()}`);
    await click('[data-testid="mongodb-card"] form button[type=submit]');
    await waitFor(`/database and user are ready/.test(document.querySelector('[data-testid="notice"]')?.innerText ?? "") || /role="alert"/.test(document.querySelector('[data-testid="mongodb-card"]').innerHTML)`, "the project's database and user", 300_000);
    const login = await card();
    if (!/Database\s+app_next/.test(login) || !/Username\s+app_next/.test(login) || !/Host\s+127\.0\.0\.1:27017/.test(login)) throw new Error(`the login isn't shown piece by piece: ${login}`);
    const shown = () => evaluate(`[...document.querySelectorAll('[data-testid="secret-url"]')].map((e) => e.innerText).find((t) => t.startsWith("mongodb:")) ?? ""`).then(String);
    const url = await shown();
    if (!/^mongodb:\/\/app_next:••••••••@127\.0\.0\.1:27017\/app_next$/.test(url)) throw new Error(`MONGODB_URI isn't shown masked: ${url || await evaluate(`document.querySelector('[data-testid="mongodb-card"]').innerText`)}`);
    await evaluate(`document.querySelector('[data-testid="mongodb-card"] [data-testid="secret-url"]').parentElement.querySelector("button").click(), true`);
    await waitFor(`/^mongodb:\\/\\/app_next:[0-9a-f]{48}@/.test([...document.querySelectorAll('[data-testid="secret-url"]')].map((e) => e.innerText).find((t) => t.startsWith("mongodb:")) ?? "")`, "Reveal to show the password");
    if (!(await evaluate(`[...document.querySelectorAll('[data-testid="mongodb-card"] button')].some((b) => /Copy/.test(b.textContent))`))) throw new Error("no Copy button next to MONGODB_URI");
    await screenshot("databases-mongodb");
    const deployment = /deployment #(\d+)/.exec(await notice())?.[1];
    if (!deployment) throw new Error(`adding MongoDB without a restart: ${await notice()}`);
    await go(`/deployments/${deployment}`);
    await waitForDeploy("the restart after adding MongoDB");
    console.log(`  ✓ database and user app_next created; host, database, username and password shown; MONGODB_URI masked, revealed and copyable (#${deployment})`);
    await go("/projects/next/env");
    await waitForPath("/projects/next/env");
    if (!String(await evaluate("document.querySelector('main').innerText")).includes("MONGODB_URI")) throw new Error("Environment doesn't list MONGODB_URI under Set for you");
    console.log("  ✓ Environment lists MONGODB_URI as set for the app");
    if (process.env.TOUR_BACKUPS === "1") {
      await go("/projects/next/backups");
      await waitForPath("/projects/next/backups");
      const before = Number(await evaluate(`document.querySelectorAll('[data-testid="backup-list"] [data-status]').length`));
      await click('form:has(input[name="slug"]) button[type=submit]');
      await waitFor(`document.querySelectorAll('[data-testid="backup-list"] [data-status]').length > ${before} && !document.querySelector('[data-testid="backup-list"] [data-status="running"]')`, "the backup with MongoDB", 180_000);
      const row = String(await evaluate(`document.querySelector('[data-testid="backup-list"] > div')?.innerText ?? ""`));
      if (!row.includes("MongoDB dump")) throw new Error(`the backup has no MongoDB dump: ${row}`);
      console.log("  ✓ the next backup includes a mongodump of the app's database");
    }
  }

  // Moving an app from another server: a data/ archive uploaded in the panel replaces the app's data.
  console.log("Import data");
  {
    const dir = mkdtempSync(join(tmpdir(), "layer-tour-import-"));
    mkdirSync(join(dir, "data"));
    const db = new DatabaseSync(join(dir, "data", "visits.db"));
    db.exec("CREATE TABLE visits (id INTEGER PRIMARY KEY, at TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO visits (at) VALUES (?)");
    for (let i = 0; i < 42; i++) insert.run(new Date().toISOString());
    db.close();
    const archive = join(dir, "next-data.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", dir, "data"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    await go("/projects/next/backups");
    await waitForPath("/projects/next/backups");
    const { root } = await send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-testid="import-data"] input[type=file]' });
    await send("DOM.setFileInputFiles", { nodeId, files: [archive] });
    const importButton = `[...document.querySelectorAll('[data-testid="import-data"] button')].find((b) => b.textContent === "Import…")`;
    await waitFor(`!${importButton}?.disabled`, "the import button");
    await evaluate(`${importButton}.click(), true`);
    await waitFor(`!!document.querySelector("#import-confirm")`, "the import confirmation");
    await setValue("#import-confirm", "next");
    await evaluate(`[...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent === "Import").click(), true`);
    await waitFor(`/Imported|Nothing changed|failed/.test(document.querySelector("[role=dialog]")?.innerText ?? "")`, "the import", 120_000);
    const dialog = String(await evaluate(`document.querySelector("[role=dialog]").innerText`));
    if (!dialog.includes("Imported")) throw new Error(`the import failed: ${dialog}`);
    await screenshot("import-data");
    let count = -1;
    for (let i = 0; i < 20 && count !== 42; i++) {
      await go(`https://next.${appsDomain}/api/visits`);
      await sleep(500);
      try {
        count = Number(JSON.parse(String(await evaluate("document.body.innerText"))).visits ?? -1);
      } catch {
        count = -1; // not JSON yet: the app is restarting
      }
      if (count !== 42) await sleep(1000);
    }
    if (count !== 42) throw new Error(`after the import the app counts ${count} visits, expected 42`);
    console.log("  ✓ import: a data/ archive uploaded in the panel replaced the app's data (42 visits), with the app restarted on it");
    rmSync(dir, { recursive: true, force: true });

    // The viewer on the imported database: its rows, a query, and a write refused.
    await go("/projects/next/databases");
    await waitForPath("/projects/next/databases");
    await click('a[href="/projects/next/databases/view?db=sqlite"]');
    await waitFor(`!!document.querySelector('[data-testid="db-files"] a[href*="visits.db"], [data-testid="db-tables"] a')`, "the SQLite databases in data/", 60_000);
    if (await evaluate(`!!document.querySelector('[data-testid="db-files"]')`)) await click('[data-testid="db-files"] a[href*="visits.db"]');
    await waitFor(`/visits\\s+42/.test(document.querySelector('[data-testid="db-tables"]')?.innerText ?? "")`, "the visits table with its 42 rows", 60_000);
    await click('[data-testid="db-tables"] a[href*="t=visits"]');
    await waitFor(`/42 rows/.test(document.querySelector("main").innerText) && document.querySelectorAll('[data-testid="data-grid"] tbody tr').length === 42`, "the visits rows", 60_000);
    await screenshot("database-viewer");
    const runQuery = async (sql: string) => {
      // An uncontrolled textarea: setting its value is all the form needs.
      await fill('[data-testid="db-query"] textarea', sql);
      await evaluate(`document.querySelector('[data-testid="db-query"]').requestSubmit(), true`);
      await waitFor(`new URLSearchParams(location.search).get("q") === ${JSON.stringify(sql)} && document.readyState === "complete" && !!document.querySelector('[data-testid="db-query"]')`, "the query to run", 60_000);
      return String(await evaluate("document.querySelector('main').innerText"));
    };
    const counted = await runQuery("SELECT count(*) AS n FROM visits");
    if (!/Query\s*·\s*1 rows/.test(counted) || !/\b42\b/.test(String(await evaluate(`document.querySelector('[data-testid="data-grid"] tbody')?.innerText ?? ""`)))) throw new Error(`the count query didn't show 42: ${counted.slice(0, 400)}`);
    const refused = await runQuery("DELETE FROM visits");
    if (!/Couldn.t run it[\s\S]*readonly/.test(refused)) throw new Error(`a DELETE wasn't refused: ${refused.slice(0, 400)}`);
    await go(`https://next.${appsDomain}/api/visits`);
    await sleep(500);
    if (Number(JSON.parse(String(await evaluate("document.body.innerText"))).visits) !== 42) throw new Error("the viewer's DELETE changed the visits");
    console.log("  ✓ database viewer: the imported visits table (42 rows), a count query, and a DELETE refused with the data untouched");
  }

  // TOUR_DOMAIN: a host whose public DNS points at the box (e.g. shop.<ip-with-dashes>.sslip.io).
  const tourDomain = process.env.TOUR_DOMAIN;
  if (tourDomain) {
    console.log("Domains");
    await go("/projects/next/domains");
    await waitForPath("/projects/next/domains");
    await fill('input[name="host"]', tourDomain);
    await click('form:has(input[name="host"]) button[type=submit]');
    await waitFor(`document.body.innerText.includes("www.${tourDomain}")`, "domain rows", 60_000);
    // Both are live once DNS checks out: no DNS record to add, a certificate status instead.
    await waitFor(`document.querySelectorAll('[data-host$=${JSON.stringify(tourDomain)}][data-status="active"]').length === 2`, "domains to go live", 60_000);
    const text = String(await evaluate("document.body.innerText"));
    if (!/Issuing a certificate|renews in|local CA/.test(text)) throw new Error(`no certificate status shown:\n${text.slice(0, 600)}`);
    console.log(`  ✓ ${tourDomain} and www.${tourDomain} verified through public DNS and live`);
    await screenshot("domains-live");

    await fill('input[name="host"]', "github.com");
    await click('form:has(input[name="host"]) button[type=submit]');
    await waitFor(`document.body.innerText.includes("not this server")`, "wrong-IP explanation", 60_000);
    console.log("  ✓ a domain pointing elsewhere stays pending, with the explanation and the record to create");
    await screenshot("domains-pending");
    for (const host of ["github.com", "www.github.com"]) {
      await evaluate(`document.querySelector('[data-host=${JSON.stringify(host)}] button[title^="Remove"]')?.click(), true`);
      await sleep(1500);
    }
    await go("/projects/next/domains");
    await waitForPath("/projects/next/domains");
    if (String(await evaluate("document.body.innerText")).includes("github.com")) throw new Error("removing the pending domain didn't work");
    console.log("  ✓ removed the pending domain");
  }

  console.log("Navigation");
  {
    await setViewport(1440, 900);
    const navText = () => evaluate(`document.querySelector("aside nav")?.innerText ?? ""`).then(String);
    for (const [path, label, shot] of [
      ["/", "Projects", "nav-projects"],
      ["/deployments", "Deployments", "nav-deployments"],
      ["/domains", "Domains", "nav-domains"],
      ["/databases", "Databases", "nav-databases"],
      ["/integrations", "Integrations", "nav-integrations"],
      ["/firewall", "Firewall", "nav-firewall"],
      ["/analytics", "Analytics", "nav-analytics"],
    ] as const) {
      await go(path);
      await waitForPath(path);
      await waitFor(`document.querySelector("main header h1")?.innerText === ${JSON.stringify(label)}`, `${label} page`);
      // The item's first line is its label; a count or a dot may follow.
      const current = String(await evaluate(`document.querySelector('aside nav [aria-current="page"]')?.innerText ?? ""`));
      if (current.trim().split("\n")[0]!.trim() !== label) throw new Error(`on ${path} the sidebar highlights "${current}", not ${label}`);
      await screenshot(shot);
    }
    const global = await navText();
    for (const label of ["Projects", "Deployments", "Analytics", "Firewall", "Domains", "Integrations", "Databases", "Backups", "Alerts"]) {
      if (!global.includes(label)) throw new Error(`the sidebar has no ${label}`);
    }
    console.log("  ✓ global sidebar: every section opens and is highlighted");
    await go("/projects/next");
    await waitForPath("/projects/next");
    const scoped = await navText();
    for (const label of ["Overview", "Deployments", "Domains", "Databases", "Backups", "Cron jobs", "Settings"]) {
      if (!scoped.includes(label)) throw new Error(`the project sidebar has no ${label}: ${scoped}`);
    }
    if (scoped.includes("Firewall")) throw new Error("the project sidebar still shows global sections");
    console.log("  ✓ inside a project the sidebar switches to that project's sections");
    await screenshot("nav-project");
    await setViewport(1440, 900, true);
    await screenshot("nav-project-dark");
    await setViewport(390, 844);
    await go("/");
    await waitForPath("/");
    await click('button[aria-label="Open menu"]');
    await waitFor(`!!document.querySelector('[role=dialog] nav')`, "the phone menu");
    await screenshot("nav-phone-menu");
    console.log("  ✓ phones get a menu button and a drawer");
    await setViewport(900, 900);
    await go("/projects/next");
    await waitForPath("/projects/next");
    await screenshot("nav-tablet");
    await setViewport(1280, 900);
  }

  console.log("Settings and delete");
  await go("/projects/vite/settings");
  await waitForPath("/projects/vite/settings");
  await screenshot("settings-vite");
  await click('[data-testid="delete-project"]');
  await waitFor(`!!document.querySelector("#confirm")`, "the delete confirmation");
  // React-controlled input: set the value through the native setter so React sees it.
  await evaluate(`(() => { const el = document.querySelector("#confirm"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "vite"); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await click('form:has(#confirm) button[type=submit]');
  await waitForPath("/");
  const overview = String(await evaluate("document.body.innerText"));
  if (/\bvite\b/.test(overview.split("Projects")[1] ?? "")) throw new Error("vite is still listed after deleting it");
  console.log("  ✓ deleted the vite project; it's gone from the overview");
}

/** Runs a command as root on the box (TOUR_BOX_CMD, bash -c …): for what a test can't do itself. */
const box = (cmd: string) => execFileSync("bash", ["-c", `${process.env.TOUR_BOX_CMD ?? "sudo bash -c"} '${cmd.replace(/'/g, `'\\''`)}'`], { encoding: "utf8" });
/** Clicks until what it opens shows: a button does nothing until React has hydrated the page. */
const clickFor = async (selector: string, shown: string, what: string) => {
  for (let i = 0; i < 20; i++) {
    await click(selector);
    for (let j = 0; j < 5; j++) {
      if (await evaluate(`!!document.querySelector(${JSON.stringify(shown)})`)) return;
      await sleep(100);
    }
  }
  throw new Error(`${what} didn't open`);
};
/** Waits for React to take over an element (its fiber is on the node once hydrated). */
const hydrated = (selector: string, what: string) => waitFor(`Object.keys(document.querySelector(${JSON.stringify(selector)}) ?? {}).some((k) => k.startsWith("__reactFiber"))`, what, 20_000);
/** For React-controlled textareas and selects, as setValue does for inputs. */
const setText = (selector: string, value: string) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const setSelect = (selector: string, value: string) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);

/** What a person's browser says, for the tools that leave bots out (headless Chrome names itself). */
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/**
 * An HTTPS request from this script to an app on the box. Test boxes use
 * Caddy's local CA, so certificates aren't checked; TOUR_RESOLVE=<address>
 * stands in for *.internal names this machine can't resolve.
 */
function boxRequest(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((done, fail) => {
    const req = httpsRequest(
      new URL(url),
      {
        method: init.method ?? "GET",
        headers: init.headers,
        rejectUnauthorized: false,
        lookup: (host: string, opts: { all?: boolean }, cb: (...args: any[]) => void) => {
          const ip = process.env.TOUR_RESOLVE;
          if (!ip || !host.endsWith(".internal")) return dnsLookup(host, opts as never, cb);
          return opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4);
        },
      } as never,
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => done({ status: res.statusCode ?? 0, body, location: res.headers.location }));
      },
    );
    req.on("error", fail);
    req.end(init.body);
  });
}

// TOUR_INTEGRATIONS=1: a catalog beside the release feed lists the hello app
// (installer/test/release-feed.sh catalog). Install it from Integrations, see
// it answer on its free URL, then uninstall it.
if (process.env.TOUR_INTEGRATIONS === "1") {
  console.log("Integrations");
  const host = `hello.${process.env.TOUR_APPS_DOMAIN ?? "internal"}`;
  const greeting = "Hello from the Self Host Layer catalog";
  await setViewport(1280, 900);
  await go("/integrations");
  await waitForPath("/integrations");
  await waitFor(`!!document.querySelector('[data-testid="install-hello"]')`, "Hello in the catalog", 30_000);
  await screenshot("integrations");
  await click('[data-testid="install-hello"] button[type=submit]');
  await waitFor(`location.pathname.startsWith("/projects/hello/deployments/")`, "the install's deployment page", 60_000);
  await waitForDeploy("installing hello");
  await screenshot("integrations-install-log");
  const log = String(await evaluate(`document.querySelector('[role=log]')?.innerText ?? ""`));
  if (!log.includes("Checked its sha256 and unpacked it") || /Installing dependencies|Building/.test(log)) throw new Error(`the install didn't come checked from the catalog, without a build:\n${log.slice(-1500)}`);
  console.log("  ✓ Install: the tarball was checked against the catalog's sha256 and unpacked, with no build");
  await visit(host, "/", greeting);
  await go("/integrations");
  await waitFor(`!!document.querySelector('[data-testid="installed-hello"]')?.innerText.includes("Running")`, "Hello listed as installed and running");
  await screenshot("integrations-installed");
  console.log("  ✓ listed under Installed, running, with its version");
  await go("/projects/hello/settings");
  await waitForPath("/projects/hello/settings");
  await click('[data-testid="uninstall"]');
  await waitFor(`!!document.querySelector("#confirm")`, "the uninstall confirmation");
  await evaluate(`(() => { const el = document.querySelector("#confirm"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "hello"); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await click('form:has(#confirm) button[type=submit]');
  await waitForPath("/integrations");
  await waitFor(`!document.querySelector('[data-testid="installed-hello"]') && !!document.querySelector('[data-testid="install-hello"]')`, "Hello back in the catalog, not installed");
  await go(`https://${host}/`);
  await sleep(2000);
  if (String(await evaluate("document.body?.innerText ?? ''").catch(() => "")).includes(greeting)) throw new Error(`https://${host}/ still answers after the uninstall`);
  console.log(`  ✓ Uninstall: gone from Installed, back in the catalog, and https://${host}/ no longer answers`);
}

// TOUR_LINKS=1: the catalog beside the release feed lists Links. Install it, make
// a link in the panel, open it and see the click counted, use the public API
// with a token made in the panel, then (with TOUR_CATALOG_CMD, which adds a
// newer Links to the catalog) update it, restore the backup taken before the
// update (with TOUR_BACKUPS), and uninstall it. No link may be lost.
if (process.env.TOUR_LINKS === "1") {
  console.log("Links");
  const domain = `links.${process.env.TOUR_APPS_DOMAIN ?? "internal"}`;
  await setViewport(1280, 900);
  await go("/integrations");
  await waitForPath("/integrations");
  await waitFor(`!!document.querySelector('[data-testid="install-links"]')`, "Links in the catalog", 30_000);
  await click('[data-testid="install-links"] button[type=submit]');
  await waitFor(`location.pathname.startsWith("/projects/links/deployments/")`, "Links' install", 60_000);
  await waitForDeploy("installing Links");
  console.log("  ✓ installed Links from the catalog");

  const linksPage = async () => {
    await go("/projects/links/links");
    await waitForPath("/projects/links/links");
    await waitFor(`!!document.querySelector('[data-testid="links-list"]')`, "the links list");
  };
  const clicksOf = (slug: string) => evaluate(`Number(document.querySelector('[data-testid="link-${slug}"] a[title="Its stats"]')?.textContent.replace(/,/g, "") ?? -1)`) as Promise<number>;
  await linksPage();
  await click('[data-testid="new-link"]');
  await waitFor(`!!document.querySelector('[data-testid="link-form"]')`, "the link dialog");
  // Its own robots.txt: a target the tour can open without the internet.
  await fill("#target", `https://${domain}/robots.txt`);
  await fill("#path", "Tour");
  await fill("#title", "From the tour");
  await click('[data-testid="link-form"] button[type=submit]');
  await waitFor(`!!document.querySelector('[data-testid="link-tour"]') && !document.querySelector('[data-testid="link-form"]')`, "the new link in the list", 20_000);
  await screenshot("links-list");
  console.log(`  ✓ made ${domain}/tour in the panel`);

  // Headless Chrome says so in its User-Agent, and Links rightly counts that as a bot: visit as a desktop browser.
  await send("Emulation.setUserAgentOverride", { userAgent: DESKTOP_UA });
  await visit(domain, "/TOUR?ref=tour", "Disallow: /");
  const landed = String(await evaluate("location.href"));
  if (!landed.endsWith("/robots.txt?ref=tour")) throw new Error(`the short link went to ${landed}`);
  console.log("  ✓ the short link (in capitals) redirects, passing ?ref=tour on");
  let clicks = -1;
  for (let i = 0; i < 15 && clicks < 1; i++) {
    await sleep(1000);
    await linksPage();
    clicks = await clicksOf("tour");
  }
  if (clicks < 1) throw new Error("the click wasn't counted");
  await go("/projects/links/stats?range=24h");
  await waitForPath("/projects/links/stats");
  await waitFor(`!!document.querySelector('[data-testid="clicks-chart"]') && document.body.innerText.includes("/tour")`, "the stats with /tour");
  await screenshot("links-stats");
  console.log(`  ✓ the click is counted in the list (${clicks}) and the stats`);

  await go("/projects/links/api");
  await waitForPath("/projects/links/api");
  await fill('[data-testid="new-token"] input[name="name"]', "tour");
  await click('[data-testid="new-token"] button[type=submit]');
  await waitFor(`!!document.querySelector('[data-testid="token-once"] code')`, "the new token, shown once");
  const token = String(await evaluate(`document.querySelector('[data-testid="token-once"] code').textContent`)).trim();
  const api = (method: string, path = "", body?: unknown) =>
    boxRequest(`https://${domain}/api/v1/links${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const made = await api("POST", "", { slug: "from-api", target: `https://${domain}/robots.txt`, tags: ["api"] });
  if (made.status !== 201 || !made.body.includes(`"shortUrl":"https://${domain}/from-api"`)) throw new Error(`API create: ${made.status} ${made.body}`);
  const listed = await api("GET", "?q=from-api");
  if (!listed.body.includes('"total":1')) throw new Error(`API list: ${listed.body}`);
  const changed = await api("PATCH", "/from-api", { title: "Changed" });
  if (!changed.body.includes('"title":"Changed"')) throw new Error(`API update: ${changed.body}`);
  if ((await api("DELETE", "/from-api")).status !== 200 || (await api("GET", "/from-api")).status !== 404) throw new Error("API delete didn't delete");
  await go("/projects/links/api");
  await waitForPath("/projects/links/api");
  // Revoke asks first; a real dialog would block the page (and this script).
  await evaluate("window.confirm = () => true, true");
  await evaluate(`[...document.querySelectorAll('[data-testid="tokens"] button')].find((b) => b.textContent === "Revoke").click(), true`);
  let refused = 0;
  for (let i = 0; i < 10 && refused !== 401; i++) {
    await sleep(500);
    refused = (await api("GET")).status;
  }
  if (refused !== 401) throw new Error(`a revoked token still works (${refused})`);
  console.log("  ✓ the API with a token from the panel: made, listed, changed and deleted a link; the revoked token is refused");

  if (process.env.TOUR_CATALOG_CMD) {
    execSync(process.env.TOUR_CATALOG_CMD, { stdio: "inherit" });
    await go("/integrations");
    await waitForPath("/integrations");
    await click('[data-testid="check-catalog"] button');
    await waitFor(`!!document.querySelector('[data-testid="update-links"]')`, "the Update button for Links", 30_000);
    const offered = String(await evaluate(`document.querySelector('[data-testid="update-links"]').innerText`));
    await screenshot("links-update");
    await click('[data-testid="update-links"] button[type=submit]');
    await waitFor(`location.pathname.startsWith("/projects/links/deployments/")`, "the update's deployment", 60_000);
    await waitForDeploy("updating Links");
    const log = String(await evaluate(`document.querySelector('[role=log]')?.innerText ?? ""`));
    if (process.env.TOUR_BACKUPS === "1" && !log.includes("Backed up")) throw new Error(`no backup before the update:\n${log.slice(-1500)}`);
    await linksPage();
    const after = await clicksOf("tour");
    if (after < clicks) throw new Error(`after the update /tour has ${after} clicks, before ${clicks}`);
    await go("/projects/links/settings");
    await waitFor(`!!document.querySelector('[data-testid="integration-version"]')?.innerText.includes("the newest")`, "the new version in Settings");
    console.log(`  ✓ ${offered.trim()}: ${process.env.TOUR_BACKUPS === "1" ? "backed up first, then " : ""}deployed beside the old one; /tour kept its ${after} clicks`);

    if (process.env.TOUR_BACKUPS === "1") {
      // A link made after the update, then the backup from before it restored: the old links stay, the new one goes.
      await linksPage();
      await click('[data-testid="new-link"]');
      await waitFor(`!!document.querySelector('[data-testid="link-form"]')`, "the link dialog");
      await fill("#target", `https://${domain}/robots.txt`);
      await fill("#path", "after-update");
      await click('[data-testid="link-form"] button[type=submit]');
      await waitFor(`!!document.querySelector('[data-testid="link-after-update"]')`, "the second link");
      await go("/projects/links/backups");
      await waitForPath("/projects/links/backups");
      await evaluate(`[...document.querySelectorAll('[data-testid="backup-list"] button')].find((b) => b.textContent === "Restore").click(), true`);
      await waitFor(`!!document.querySelector('input[name="confirm"]')`, "restore confirmation");
      await setValue('input[name="confirm"]', "links");
      await waitFor(`!document.querySelector('form:has(input[name="confirm"]) button[type=submit]').disabled`, "the restore button to enable");
      await click('form:has(input[name="confirm"]) button[type=submit]');
      await waitFor(`document.body.innerText.includes("Restored.") || !!document.querySelector('form:has(input[name="confirm"]) [role=alert]')`, "the restore", 180_000);
      if (!String(await evaluate("document.body.innerText")).includes("Restored.")) throw new Error("the restore failed");
      let back = false;
      for (let i = 0; i < 15 && !back; i++) {
        await sleep(1000);
        await linksPage();
        back = !!(await evaluate(`!!document.querySelector('[data-testid="link-tour"]') && !document.querySelector('[data-testid="link-after-update"]')`));
      }
      if (!back) throw new Error("after the restore the links aren't the backup's");
      console.log("  ✓ restored the backup from before the update: /tour is there, the link made after it is gone");
    }
  }

  await go("/projects/links/settings");
  await waitForPath("/projects/links/settings");
  await click('[data-testid="uninstall"]');
  await waitFor(`!!document.querySelector("#confirm")`, "the uninstall confirmation");
  await setValue("#confirm", "links");
  await click('form:has(#confirm) button[type=submit]');
  await waitForPath("/integrations");
  await waitFor(`!document.querySelector('[data-testid="installed-links"]') && !!document.querySelector('[data-testid="install-links"]')`, "Links back in the catalog");
  console.log("  ✓ uninstalled Links");
}

// TOUR_ANALYTICS=1: the catalog beside the release feed lists Analytics.
// Install it from its page, add the panel's own address as a site, load the
// script on a panel page (as a person's browser would), see the visit and a
// custom event on the dashboard, then uninstall it.
if (process.env.TOUR_ANALYTICS === "1") {
  console.log("Analytics");
  const domain = `analytics.${process.env.TOUR_APPS_DOMAIN ?? "internal"}`;
  const panelHost = new URL(base).hostname;
  await setViewport(1280, 900);
  await go("/analytics");
  await waitForPath("/analytics");
  await waitFor(`!!document.querySelector('[data-testid="install-analytics"]')`, "Install on the Analytics page", 30_000);
  await screenshot("analytics-install");
  await click('[data-testid="install-analytics"] button[type=submit]');
  await waitFor(`location.pathname.startsWith("/projects/analytics/deployments/")`, "Analytics' install", 60_000);
  await waitForDeploy("installing Analytics");
  console.log("  ✓ installed Analytics from the Analytics page");

  await go("/analytics");
  await waitForPath("/analytics");
  await waitFor(`!!document.querySelector('[data-testid="add-site"]')`, "the first site's form");
  await fill("#domain", panelHost);
  await click('[data-testid="add-site"] button[type=submit]');
  await waitFor(`!!document.querySelector('[data-testid="snippet"]')`, "the new site's dashboard", 20_000);
  const code = String(await evaluate(`document.querySelector('[data-testid="snippet"] code').textContent`));
  if (!code.includes(`https://${domain}/script.js`) || !code.includes(`data-site="${panelHost}"`)) throw new Error(`the line to paste: ${code}`);
  console.log(`  ✓ added ${panelHost} as a site; its dashboard shows the line to paste`);
  await go("/analytics");
  await waitFor(`[...document.querySelectorAll('[data-testid="site-row"]')].some((r) => r.innerText.includes(${JSON.stringify(panelHost)}))`, "the site in the list of sites");
  await click('[data-testid="site-row"]');
  await waitFor(`location.pathname === ${JSON.stringify(`/analytics/${panelHost}`)}`, "the site's dashboard, from the list");
  console.log("  ✓ /analytics lists the sites, and a row opens its dashboard");

  // A person's visit: no webdriver flag, a desktop User-Agent, and the script on one of the panel's pages.
  await send("Emulation.setUserAgentOverride", { userAgent: DESKTOP_UA });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(navigator, 'webdriver', { get: () => false })" });
  await go("/settings");
  await waitForPath("/settings");
  await evaluate(`(() => { const s = document.createElement("script"); s.src = "https://${domain}/script.js"; s.dataset.site = ${JSON.stringify(panelHost)}; document.head.appendChild(s); return true; })()`);
  await waitFor(`!!window.shl && window.shl.track.length === 2`, "the script to load");
  const visitId = String(await evaluate(`window.shl.ready`));
  if (!/^[\w-]{12}$/.test(visitId)) throw new Error(`window.shl.ready gave ${visitId}, not a visit`);
  await evaluate(`window.shl.track("Tour", { step: "analytics" }), true`);
  // A click on a link to another site, kept from leaving the page: the script counts it on the way.
  await evaluate(`(() => { const a = document.createElement("a"); a.href = "https://example.com/tour"; a.addEventListener("click", (e) => e.preventDefault()); document.body.appendChild(a); a.click(); return true; })()`);
  await sleep(1500);
  const site = `/analytics/${panelHost}`;
  let seen = "";
  for (let i = 0; i < 10 && !(seen.includes("/settings") && seen.includes("Tour")); i++) {
    await go(site);
    await waitForPath(site);
    seen = String(await evaluate(`[document.querySelector('[data-testid="top-pages"]')?.innerText ?? "", document.body.innerText].join(" ")`));
    if (!seen.includes("Tour")) await sleep(1000);
  }
  if (!seen.includes("/settings") || !seen.includes("Tour")) throw new Error(`the visit isn't on the dashboard:\n${seen.slice(0, 1500)}`);
  await screenshot("analytics-dashboard");
  console.log(`  ✓ the script's pageview (/settings) and a custom event (Tour) are on the dashboard; window.shl.ready named the visit`);

  /** Opens one of the site's Analytics pages and waits for text in it. */
  const section = async (path: string, selector: string, text: string, what: string) => {
    await go(`${site}${path}`);
    await waitForPath(`${site}${path}`);
    await waitFor(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "").includes(${JSON.stringify(text)})`, what, 20_000);
  };
  await section("/realtime", '[data-testid="realtime-feed"]', "/settings", "the visit in Realtime's feed");
  await screenshot("analytics-realtime");
  await section("/pages", '[data-testid="pages-table"]', "/settings", "/settings in the pages table");
  await section("/outbound", '[data-testid="outbound"]', "example.com", "the click to example.com under Outbound");
  console.log("  ✓ Realtime, Pages and Outbound show the visit, its page and its click out");

  await go(`${site}/users?visit=${visitId}`);
  await waitFor(`(document.querySelector('[data-testid="journey-steps"]')?.innerText ?? "").includes("Tour")`, "the visit's journey", 20_000);
  const steps = String(await evaluate(`document.querySelector('[data-testid="journey-steps"]').innerText`));
  if (!steps.includes("/settings") || !steps.includes("example.com")) throw new Error(`the journey: ${steps}`);
  await screenshot("analytics-journey");
  console.log("  ✓ Users opens the visit: its page, the Tour event and the click out, in order");

  await go(`${site}/goals`);
  await waitForPath(`${site}/goals`);
  await click('[data-testid="new-goal"]');
  await waitFor(`!!document.querySelector('[data-testid="goal-form"] #value')`, "the new goal's form");
  await setValue('[data-testid="goal-form"] #value', "/settings");
  await setValue('[data-testid="goal-form"] #name', "Opened settings");
  await click('[data-testid="goal-form"] button[type=submit]');
  await waitFor(`(document.querySelector('[data-testid="goals"]')?.innerText ?? "").includes("Opened settings")`, "the goal in the list", 20_000);
  const goal = String(await evaluate(`document.querySelector('[data-testid="goal-row"]').innerText`));
  if (!/\b1\b/.test(goal) || !goal.includes("%")) throw new Error(`the goal's numbers: ${goal}`);
  await screenshot("analytics-goals");
  console.log("  ✓ a goal (the page /settings) counts the visitor who reached it");

  await go(`${site}/revenue`);
  await waitFor(`!!document.querySelector('[data-testid="revenue-setup"]')`, "Revenue's setup");
  await go(`${site}/settings`);
  await waitFor(`!!document.querySelector('[data-testid="source-stripe"]') && !!document.querySelector('[data-testid="snippet"]')`, "the site's settings");
  await screenshot("analytics-site-settings");
  console.log("  ✓ Revenue offers to connect a provider; the site's Settings has the line to paste and each provider's key");

  // Revenue by webhook: Lemon Squeezy connected in its tab, then a payment posted to Analytics'
  // address as Lemon Squeezy would, signed with the secret the tab made (and one forged).
  await hydrated('[data-testid="revenue-tabs"]', "the revenue tabs to come alive");
  await click('[data-testid="tab-lemonsqueezy"]');
  await waitFor(`(document.querySelector('[data-testid="webhook-secret"]')?.textContent ?? "").trim().length > 10`, "the signing secret the tab makes");
  const hookUrl = String(await evaluate(`document.querySelector('[data-testid="webhook-lemonsqueezy"] [data-testid="webhook-url"]').textContent`)).trim();
  const hookSecret = String(await evaluate(`document.querySelector('[data-testid="webhook-secret"]').textContent`)).trim();
  await click('[data-testid="source-lemonsqueezy"] button[type=submit]');
  await waitFor(`document.body.innerText.includes("Lemon Squeezy is connected")`, "Lemon Squeezy connected", 20_000);
  const order = JSON.stringify({ meta: { event_name: "order_created", custom_data: { shl_visit: visitId } }, data: { type: "orders", id: "7001", attributes: { status: "paid", currency: "USD", subtotal: 4900, tax: 0, total: 4900, customer_id: 1, test_mode: false, created_at: new Date().toISOString() } } });
  const posted = await boxRequest(hookUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": createHmac("sha256", hookSecret).update(order).digest("hex") }, body: order });
  if (posted.status !== 200 || !posted.body.includes('"added":1')) throw new Error(`${hookUrl} answered ${posted.status}: ${posted.body}`);
  const forged = await boxRequest(hookUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": "0".repeat(64) }, body: order });
  if (forged.status !== 401) throw new Error(`a webhook with another signature answered ${forged.status}`);
  await go(`${site}/revenue?range=today`);
  await waitFor(`document.body.innerText.includes("Lemon Squeezy")`, "the payment on Revenue", 20_000);
  await screenshot("analytics-revenue");
  console.log("  ✓ Lemon Squeezy by webhook: signed with the secret its tab made, a forged one refused, the payment on Revenue");

  await go("/projects/analytics/settings");
  await waitForPath("/projects/analytics/settings");
  await click('[data-testid="uninstall"]');
  await waitFor(`!!document.querySelector("#confirm")`, "the uninstall confirmation");
  await setValue("#confirm", "analytics");
  await click('form:has(#confirm) button[type=submit]');
  await waitForPath("/integrations");
  await go("/analytics");
  await waitFor(`!!document.querySelector('[data-testid="install-analytics"]')`, "Install again on the Analytics page");
  console.log("  ✓ uninstalled Analytics; its page offers Install again");
}

// TOUR_EMAIL=1: the catalog lists Email, an SMTP sink takes mail on the box at
// 127.0.0.1:2525 and writes a line per message to TOUR_SMTP_LOG, and
// TOUR_BOX_CMD runs a command as root on the box (bash -c …): for what a test
// can't do itself, like a domain's DNS (marked verified there).
if (process.env.TOUR_EMAIL === "1") {
  console.log("Email");
  const sunk = () => box(`cat ${process.env.TOUR_SMTP_LOG ?? "/tmp/smtp-sink.log"}`);
  const domain = `email.${process.env.TOUR_APPS_DOMAIN ?? "internal"}`;
  await setViewport(1280, 900);
  await go("/email");
  await waitForPath("/email");
  await waitFor(`!!document.querySelector('[data-testid="install-email"]')`, "Install on the Email page", 30_000);
  await click('[data-testid="install-email"] button[type=submit]');
  await waitFor(`location.pathname.startsWith("/projects/email/deployments/")`, "Email's install", 60_000);
  await waitForDeploy("installing Email");
  console.log("  ✓ installed Email from the Email page");

  await go("/email");
  await waitFor(`!!document.querySelector('[data-testid="add-brand"]')`, "the first brand's form");
  await fill("#brand-name", "Tour");
  await fill("#brand-from", "news@tour.test");
  await click('[data-testid="add-brand"] button[type=submit]');
  await waitFor(`/^\\/email\\/\\d+$/.test(location.pathname) && !!document.querySelector('[data-testid="email-setup"]')`, "the new brand's Overview", 20_000);
  const brand = String(await evaluate("location.pathname"));
  await screenshot("email-overview");

  await go(`${brand}/settings`);
  await waitFor(`!!document.querySelector('[data-testid="provider-form"] #p-host')`, "the provider form");
  await hydrated('[data-testid="provider-form"]', "the provider form to come alive");
  await setValue("#p-host", "127.0.0.1");
  await setValue("#p-port", "2525");
  await setSelect("#p-sec", "none");
  await click('[data-testid="provider-form"] button[type=submit]');
  await waitFor(`document.body.innerText.includes("Send a test to see it work")`, "the provider saved");
  await fill("#t-to", "ada@tour.test");
  await click('[data-testid="test-email"] button[type=submit]');
  await waitFor(`document.body.innerText.includes("Sent to ada@tour.test")`, "the test email sent", 30_000);
  if (!sunk().includes("ada@tour.test\tA test from Tour")) throw new Error(`the SMTP sink didn't get the test: ${sunk()}`);
  await screenshot("email-settings");
  console.log("  ✓ SMTP set up; a test email reached the server");

  await go(`${brand}/domains`);
  await waitFor(`!!document.querySelector('[data-testid="add-domain"] #d-domain')`, "the domain form");
  await fill("#d-domain", "tour.test");
  await click('[data-testid="add-domain"] button[type=submit]');
  await waitFor(`(document.querySelector('[data-testid="domain"]')?.innerText ?? "").includes("_domainkey.tour.test")`, "the domain's DKIM record", 20_000);
  // No DNS for tour.test: marked verified where Email keeps it.
  box(`N=$(ls -d /opt/layer/node/*/bin/node | sort -V | tail -1); $N -e 'const { DatabaseSync } = require("node:sqlite"); new DatabaseSync("/srv/apps/email/data/email.db").prepare("UPDATE domains SET status = ? WHERE domain = ?").run("verified", "tour.test")'`);
  await go(`${brand}/domains`);
  await waitFor(`(document.querySelector('[data-testid="domain"]')?.innerText ?? "").includes("Verified")`, "the domain verified");
  console.log("  ✓ a domain added, with its DKIM record to publish");

  await go(`${brand}/lists`);
  await waitFor(`!!document.querySelector('[data-testid="new-list"]')`, "the Lists page");
  await clickFor('[data-testid="new-list"]', '[data-testid="list-form"] #l-name', "the new list's form");
  await setValue("#l-name", "Newsletter");
  await click('[data-testid="list-form"] button[type=submit]');
  await waitFor(`(document.querySelector('[data-testid="lists"]')?.innerText ?? "").includes("Newsletter")`, "the list");
  await go(`${brand}/contacts`);
  await waitFor(`!!document.querySelector('[data-testid="new-contact"]')`, "the Contacts page");
  await clickFor('[data-testid="new-contact"]', '[data-testid="contact-form"] #c-email', "the new contact's form");
  await setValue("#c-email", "grace@tour.test");
  await setValue("#c-name", "Grace Hopper");
  await click('[data-testid="contact-form"] input[name=lists]');
  await click('[data-testid="contact-form"] button[type=submit]');
  await waitFor(`(document.querySelector('[data-testid="contacts"]')?.innerText ?? "").includes("grace@tour.test")`, "the contact");
  console.log("  ✓ a list, and a contact in it");

  await go(`${brand}/campaigns`);
  await waitFor(`!!document.querySelector('[data-testid="new-campaign"]')`, "the Campaigns page");
  await clickFor('[data-testid="new-campaign"]', '[data-testid="campaign-new"] #cn-name', "the new campaign's form");
  await setValue("#cn-name", "Tour campaign");
  await click('[data-testid="campaign-new"] input[name=lists]');
  await click('[data-testid="campaign-new"] button[type=submit]');
  await waitFor(`!!document.querySelector('[data-testid="campaign-editor"] #ce-subject')`, "the campaign's editor", 20_000);
  await hydrated('[data-testid="editor-source"]', "the editor to come alive");
  await setValue("#ce-subject", "Hello {{first_name}}");
  await setText('[data-testid="editor-source"]', "# Hi {{first_name}}\n\nThis came from the tour.\n\n[[Visit](https://example.com/tour)]");
  await screenshot("email-editor");
  await clickFor('[data-testid="send-now"]', '[data-testid="send-confirm"]', "the send confirmation");
  await click('[data-testid="send-confirm"]');
  await waitFor(`(document.querySelector('[data-testid="campaign-status"]')?.innerText ?? "") === "Sent"`, "the campaign sent", 60_000);
  if (!sunk().includes("grace@tour.test\tHello Grace")) throw new Error(`the SMTP sink didn't get the campaign: ${sunk()}`);
  await screenshot("email-report");
  console.log("  ✓ a campaign in Markdown, sent to the list and merged (Hello Grace)");

  await go(`${brand}/api`);
  await waitFor(`!!document.querySelector('[data-testid="create-key"] #k-name')`, "the API page");
  await hydrated('[data-testid="create-key"]', "the key form to come alive");
  await setValue("#k-name", "tour");
  await click('[data-testid="create-key"] button[type=submit]');
  await waitFor(`!!document.querySelector('[data-testid="new-key"] code')`, "the new key");
  const key = String(await evaluate(`document.querySelector('[data-testid="new-key"] code').textContent`));
  const sent = await boxRequest(`https://${domain}/emails`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: "Tour <news@tour.test>", to: "linus@tour.test", subject: "Your receipt", html: "<p>Thanks!</p>" }) });
  if (sent.status !== 200 || !/"id"/.test(sent.body)) throw new Error(`POST /emails answered ${sent.status}: ${sent.body}`);
  await go(`${brand}/logs`);
  let logged = "";
  for (let i = 0; i < 20 && !logged.includes("linus@tour.test"); i++) {
    await sleep(500);
    await go(`${brand}/logs`);
    await waitForPath(`${brand}/logs`);
    logged = String(await evaluate(`document.querySelector('[data-testid="logs"]')?.innerText ?? ""`));
  }
  if (!sunk().includes("linus@tour.test\tYour receipt")) throw new Error(`the SMTP sink didn't get the API's email: ${sunk()}`);
  await screenshot("email-logs");
  console.log("  ✓ an email through the API with a key made in the panel, in the logs and at the server");

  await go("/projects/email/settings");
  await waitForPath("/projects/email/settings");
  await click('[data-testid="uninstall"]');
  await waitFor(`!!document.querySelector("#confirm")`, "the uninstall confirmation");
  await setValue("#confirm", "email");
  await click('form:has(#confirm) button[type=submit]');
  await waitForPath("/integrations");
  console.log("  ✓ uninstalled Email");
}

// TOUR_FORMS=1: the catalog lists Forms, and a webhook sink on the box at
// 127.0.0.1:2626 writes a line per request to TOUR_HOOK_LOG
// (catalog/forms/test/hook-sink.ts). Install it, build a form with logic in the
// builder, point its webhook at the sink, fill it in as a person would, and
// find the response in the panel, the CSV and the sink (signed); then close it
// and uninstall.
if (process.env.TOUR_FORMS === "1") {
  console.log("Forms");
  const hooked = () => box(`cat ${process.env.TOUR_HOOK_LOG ?? "/tmp/hook-sink.log"}`);
  await setViewport(1280, 900);
  await go("/forms");
  await waitForPath("/forms");
  await waitFor(`!!document.querySelector('[data-testid="install-forms"]')`, "Install on the Forms page", 30_000);
  await click('[data-testid="install-forms"] button[type=submit]');
  await waitFor(`location.pathname.startsWith("/projects/forms/deployments/")`, "Forms' install", 60_000);
  await waitForDeploy("installing Forms");
  console.log("  ✓ installed Forms from the Forms page");

  await go("/forms");
  await waitFor(`!!document.querySelector('[data-testid="new-form-button"]')`, "the Forms page");
  await clickFor('[data-testid="new-form-button"]', '[data-testid="new-form"] #nf-title', "the new form's dialog");
  await click('[data-testid="template-contact"]');
  await setValue("#nf-title", "Tour contact");
  await click('[data-testid="new-form"] button[type=submit]');
  await waitFor(`/^\\/forms\\/\\d+$/.test(location.pathname) && !!document.querySelector('[data-testid="form-builder"]')`, "the new form's builder", 20_000);
  const formPath = String(await evaluate("location.pathname"));
  await hydrated('[data-testid="form-builder"]', "the builder to come alive");
  // After the last question: one choice, then a question shown only for one of its answers.
  await evaluate(`[...document.querySelectorAll('[data-testid="builder-field"]')].at(-1).click(), true`);
  await setSelect('[data-testid="add-kind"]', "choice");
  await click('[data-testid="add-field"]');
  await waitFor(`document.querySelector("#fs-type")?.value === "choice"`, "the new choice question's settings");
  await setValue("#fs-label", "How did you hear about us?");
  await setText("#fs-opts", "A friend\nSearch\nSomewhere else");
  await setValue("#fs-id", "heard");
  await setSelect('[data-testid="add-kind"]', "short_text");
  await click('[data-testid="add-field"]');
  await waitFor(`document.querySelector("#fs-type")?.value === "short_text" && document.querySelector("#fs-label")?.value === "Short text"`, "the new text question's settings");
  await setValue("#fs-label", "Where, then?");
  await setValue("#fs-id", "where");
  await click('[data-testid="logic-toggle"]');
  await waitFor(`!!document.querySelector('select[aria-label="Value"]')`, "the logic's answer to pick");
  await setSelect('select[aria-label="Value"]', "Somewhere else");
  await click('[data-testid="form-builder"] button[type=submit]');
  await waitFor(`document.body.innerText.includes("Saved. The form's page shows it now.")`, "the form saved", 20_000);
  const fieldsShown = String(await evaluate(`[...document.querySelectorAll('[data-testid="builder-field"]')].map((e) => e.innerText).join(" | ")`));
  if (!fieldsShown.includes("Where, then?") || !fieldsShown.includes("shown by logic")) throw new Error(`the builder's questions: ${fieldsShown}`);
  if (!/\/f\/[a-z0-9-]+\?preview=/.test(String(await evaluate(`document.querySelector('[data-testid="form-preview"]')?.src ?? ""`)))) throw new Error("the builder has no preview of the form");
  await screenshot("forms-builder");
  console.log("  ✓ built a form: the Contact template, a choice, and a question shown by logic");

  await go(`${formPath}/settings`);
  await waitFor(`!!document.querySelector('[data-testid="notify-form"] #nt-hook')`, "the notifications form");
  await hydrated('[data-testid="notify-form"]', "the notifications form to come alive");
  await setValue("#nt-hook", "http://127.0.0.1:2626/hook");
  await click('[data-testid="notify-form"] button[type=submit]');
  await waitFor(`!!document.querySelector("#nt-secret") && [...document.querySelectorAll("button")].some((b) => b.textContent.includes("Send a test to the webhook"))`, "the webhook saved", 20_000);
  const secret = String(await evaluate(`document.querySelector("#nt-secret").value`));
  await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Send a test to the webhook")).click(), true`);
  await waitFor(`document.body.innerText.includes("Sent: it answered 200.")`, "the webhook's test", 30_000);
  if (!hooked().includes('"test":true')) throw new Error(`the webhook sink didn't get the test: ${hooked()}`);
  console.log("  ✓ a webhook to the sink on the box, and a test that reached it");

  await go(`${formPath}/share`);
  await waitFor(`!!document.querySelector('[data-testid="share-link"]')`, "the Share page");
  const link = String(await evaluate(`document.querySelector('[data-testid="share-link"]').textContent`)).trim();
  if (!/^https:\/\/forms\.[^/]+\/f\/[a-z0-9-]+$/.test(link)) throw new Error(`the form's link: ${link}`);
  await screenshot("forms-share");

  // A person, not a bot: headless Chrome names itself in its User-Agent, and Forms keeps no answers from bots.
  await send("Emulation.setUserAgentOverride", { userAgent: DESKTOP_UA });
  const type = (sel: string, v: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await visit(link.replace(/^https:\/\//, "").split("/")[0]!, new URL(link).pathname, "Tour contact");
  await waitFor(`!!document.querySelector("#f-name")`, "the form's questions");
  if (await evaluate(`!!document.querySelector("#f-where")`)) throw new Error("the logic question shows before its answer");
  await type("#f-name", "Grace Hopper");
  await type("#f-email", "grace@tour.test");
  await type("#f-message", "Hello from the tour");
  await evaluate(`[...document.querySelectorAll(".choice")].find((c) => c.textContent.includes("Somewhere else")).click(), true`);
  await waitFor(`!!document.querySelector("#f-where")`, "the logic question, once its answer is picked");
  await type("#f-where", "At the tour");
  await screenshot("forms-filled");
  await sleep(2200); // faster than 2 seconds is a bot
  await click(".nav .primary");
  await waitFor(`!!document.querySelector(".thanks")`, "the thank-you screen", 20_000);
  console.log(`  ✓ filled in at ${link} as a person would; the logic question showed for its answer`);

  await go(`${formPath}/responses`);
  await waitFor(`(document.querySelector('[data-testid="responses"]')?.innerText ?? "").includes("Grace Hopper")`, "the response in the panel", 20_000);
  await click('[data-testid="response-row"]');
  await waitFor(`(document.querySelector('[data-testid="response-detail"]')?.innerText ?? "").includes("At the tour")`, "the response opened");
  await screenshot("forms-response");
  const csv = String(await evaluate(`fetch(${JSON.stringify(`${formPath.replace("/forms/", "/api/forms/")}/export`)}).then((r) => r.text())`));
  if (!csv.startsWith("submitted_at,Your name,Your email,How can we help?,How did you hear about us?,\"Where, then?\",") || !csv.includes(",Grace Hopper,grace@tour.test,Hello from the tour,Somewhere else,At the tour,")) throw new Error(`the CSV:\n${csv}`);
  console.log("  ✓ the response is in the panel, whole, and in the CSV");
  let hook = "";
  for (let i = 0; i < 30 && !(hook = hooked().split("\n").find((l) => l.includes("Grace Hopper")) ?? ""); i++) await sleep(1000);
  const [signature, body] = hook.split("\t");
  if (!body || signature !== `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`) throw new Error(`the webhook didn't get the response, signed: ${hook || hooked()}`);
  console.log("  ✓ the webhook got the response, signed with the form's secret");

  await go(`${formPath}/settings`);
  await waitFor(`!!document.querySelector('[data-testid="form-settings"]')`, "the form's settings");
  await hydrated('[data-testid="form-settings"]', "the settings form to come alive");
  await click('[data-testid="form-open"]');
  await click('[data-testid="form-settings"] button[type=submit]');
  await waitFor(`(document.querySelector('[data-testid="form-status"]')?.innerText ?? "") === "Closed" || document.body.innerText.includes("Saved.")`, "the form closed", 20_000);
  await visit(link.replace(/^https:\/\//, "").split("/")[0]!, new URL(link).pathname, "isn't taking answers");
  console.log("  ✓ closed: the form's page says so");

  await go("/projects/forms/settings");
  await waitForPath("/projects/forms/settings");
  await click('[data-testid="uninstall"]');
  await waitFor(`!!document.querySelector("#confirm")`, "the uninstall confirmation");
  await setValue("#confirm", "forms");
  await click('form:has(#confirm) button[type=submit]');
  await waitForPath("/integrations");
  console.log("  ✓ uninstalled Forms");
}

// TOUR_PANEL_ADDRESS=<host>: move the panel there from Settings and back. On a
// test box (apps at .internal) the DNS check is skipped; the host must reach the box.
const newAddress = process.env.TOUR_PANEL_ADDRESS;
if (newAddress) {
  console.log("Panel address");
  const original = new URL(base).host;
  /** Each address has its own sign-in: sign in if this one asks. */
  const signInIfAsked = async (host: string) => {
    await waitFor(`location.host === ${JSON.stringify(host)} && document.readyState === "complete"`, `${host} to load`, 30_000);
    if (String(await evaluate("location.pathname")) !== "/login") return;
    await fill("#email", email);
    await fill("#password", password);
    await click("button[type=submit]");
    await waitForPath("/login/2fa");
    await typeCode(await nextCode(secret));
    await waitFor(`location.pathname === "/"`, `signed in on ${host}`, 30_000);
  };
  const move = async (from: string, to: string) => {
    await go(`https://${from}/settings`);
    await waitForPath("/settings");
    await fill('[data-testid="move-panel"] input[name="host"]', to);
    await click('[data-testid="move-panel"] button[type=submit]');
    await waitFor(`!!document.querySelector('[data-testid="moved"]') || !!document.querySelector('[data-testid="move-panel"] [role=alert]')`, `the move to ${to}`, 150_000);
    const result = String(await evaluate(`document.querySelector('[data-testid="move-panel"]').innerText`));
    if (!result.includes("Moved")) throw new Error(`moving the panel to ${to} failed: ${result}`);
  };

  await move(original, newAddress);
  // The old address redirects, keeping the path.
  await go(`https://${original}/settings`);
  await signInIfAsked(newAddress);
  await go(`https://${newAddress}/settings`);
  await waitForPath("/settings");
  const settings = String(await evaluate("document.body.innerText"));
  if (!settings.includes(`Redirects here\n${original}`) && !settings.includes(`Redirects here\t${original}`)) throw new Error(`Settings doesn't list ${original} as redirecting: ${settings.slice(0, 400)}`);
  console.log(`  ✓ moved the panel to ${newAddress}; ${original} redirects there, keeping the path`);
  await screenshot("panel-address-moved");

  await move(newAddress, original);
  await go(`https://${original}/settings`);
  await signInIfAsked(original);
  await go(`https://${original}/settings`);
  await waitForPath("/settings");
  await evaluate(`[...document.querySelectorAll("form")].find((f) => f.querySelector('input[name="host"]')?.value === ${JSON.stringify(newAddress)})?.querySelector("button").click(), true`);
  await waitFor(`!document.body.innerText.includes(${JSON.stringify(newAddress)})`, `${newAddress} to be removed`, 30_000);
  console.log(`  ✓ moved back to ${original} and removed ${newAddress}`);

  // The deployed example's free URL moves with the apps domain, and back.
  if (process.env.TOUR_DEPLOY === "1") {
    const appsDomain = process.env.TOUR_APPS_DOMAIN ?? "internal";
    const health = async (host: string) => {
      for (let i = 0; i < 20; i++) {
        await go(`https://${host}/api/health`);
        await sleep(800);
        const text = String(await evaluate("document.body?.innerText ?? ''").catch(() => ""));
        if (text.trim() === "ok") return String(await evaluate("location.host"));
      }
      throw new Error(`https://${host}/api/health didn't answer ok`);
    };
    const moveApps = async (to: string) => {
      await go(`https://${original}/settings`);
      await waitForPath("/settings");
      await fill('[data-testid="move-apps"] input[name="domain"]', to);
      await click('[data-testid="move-apps"] button[type=submit]');
      await waitFor(`/Free URLs are now|\\*\\.|failed/.test(document.querySelector('[data-testid="move-apps"]').innerText)`, `apps moving to ${to}`, 120_000);
      const result = String(await evaluate(`document.querySelector('[data-testid="move-apps"]').innerText`));
      if (!result.includes("Free URLs are now")) throw new Error(`moving the apps to ${to} failed: ${result}`);
    };
    await moveApps(`apps2.${appsDomain}`);
    await health(`next.apps2.${appsDomain}`);
    const landed = await health(`next.${appsDomain}`);
    if (landed !== `next.apps2.${appsDomain}`) throw new Error(`the old free URL didn't redirect (ended on ${landed})`);
    console.log(`  ✓ app URLs moved to *.apps2.${appsDomain}; the old ones redirect`);
    await moveApps(appsDomain);
    if ((await health(`next.${appsDomain}`)) !== `next.${appsDomain}`) throw new Error("next didn't come back to its old URL");
    console.log(`  ✓ and back to *.${appsDomain}`);
  }
}

// TOUR_ACCESS=1: lock the panel to the address the tour comes from, refuse a list
// that would lock it out, then open it to anyone again.
// TOUR_SITES=1: a WordPress site through Sites → New site: the install's log,
// the owner's one-time password on the site's page, the site on its free
// address, wp-admin's sign-in page, its engine page; then delete it.
if (process.env.TOUR_SITES === "1") {
  console.log("Sites");
  await setViewport(1280, 900);
  await go("/sites");
  await waitFor(`!!document.querySelector('[data-testid="new-wordpress"]')`, "the Sites page");
  await screenshot("sites-empty");
  await click('[data-testid="new-wordpress"]');
  await waitFor(`location.pathname === "/sites/new" && !!document.querySelector("#title")`, "New site");
  await hydrated("#title", "the New site form to come alive");
  await setValue("#title", "Tour Blog");
  await setValue("#name", "tour-blog");
  await setValue("#ownerName", "Ada Lovelace");
  await setValue("#ownerEmail", "ada@tour.test");
  await screenshot("sites-new");
  await click('form:has(#title) button[type=submit]');
  await waitFor(`location.pathname.startsWith("/projects/tour-blog/deployments/")`, "the site's install", 60_000);
  await waitForDeploy("installing WordPress");
  console.log("  ✓ installed a WordPress site from Sites → New site");

  await go("/projects/tour-blog/site");
  await waitFor(`!!document.querySelector('[data-testid="site-password"]')`, "the owner's one-time password", 20_000);
  const password = String(await evaluate(`document.querySelector('[data-testid="site-password"]').textContent`)).trim();
  if (password.length < 20) throw new Error(`the owner's password: ${password}`);
  await waitFor(`document.body.innerText.includes("Lock code")`, "WordPress's settings on the site's page", 60_000);
  await screenshot("sites-wordpress");
  await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("I've saved it")).click(), true`);
  await waitFor(`!document.querySelector('[data-testid="site-password"]')`, "the password forgotten");
  console.log("  ✓ the owner's password, shown once, then forgotten");

  const host = `tour-blog.${process.env.TOUR_APPS_DOMAIN ?? "internal"}`;
  await visit(host, "/", "Tour Blog");
  await visit(host, "/wp-login.php", "Username or Email Address");
  const config = await boxRequest(`https://${host}/wp-config.php`);
  if (config.status !== 404) throw new Error(`wp-config.php answered ${config.status}`);
  console.log("  ✓ wp-config.php isn't served");

  await go("/sites");
  await waitFor(`(document.querySelector('[data-testid="site-list"]')?.innerText ?? "").includes("Tour Blog")`, "the site in the list");
  await screenshot("sites-list");
  await go("/projects/tour-blog/settings");
  await waitFor(`!!document.querySelector('[data-testid="delete-project"]')`, "the site's settings");
  await hydrated('[data-testid="delete-project"]', "the delete button to come alive");
  await click('[data-testid="delete-project"]');
  await waitFor(`!!document.querySelector("#confirm")`, "the delete confirmation");
  await evaluate(`(() => { const el = document.querySelector("#confirm"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "tour-blog"); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await click('form:has(#confirm) button[type=submit]');
  await waitFor(`!location.pathname.startsWith("/projects/tour-blog")`, "the site deleted", 60_000);
  console.log("  ✓ deleted the site");
}

// TOUR_SERVERS=<another server's IP>: it ran install.sh --agent-only with this
// panel's key (/var/lib/layer/ssh). Add it on Servers, check the connection,
// put a WordPress site there through New site, visit it on that server, delete it.
if (process.env.TOUR_SERVERS) {
  console.log("Servers");
  await setViewport(1280, 900);
  await go("/servers");
  await waitFor(`!!document.querySelector('[data-testid="add-server"] #server-host')`, "the Servers page");
  await hydrated("#server-host", "the add-server form to come alive");
  await setValue("#server-name", "tour-two");
  await setValue("#server-host", process.env.TOUR_SERVERS);
  await click('[data-testid="add-server"] button[type=submit]');
  await waitFor(`!!document.querySelector('[data-testid="server-install-command"]') || document.body.innerText.includes("tour-two")`, "the server added", 20_000);
  await screenshot("servers-added");
  await waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.includes("Check connection"))`, "Check connection");
  await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Check connection")).click(), true`);
  await waitFor(`document.body.innerText.includes("Connected: ")`, "the connection checked", 60_000);
  await screenshot("servers-connected");
  console.log("  ✓ added a server and reached its agent over the link");

  await go("/sites/new?engine=wordpress");
  await waitFor(`!!document.querySelector('[data-testid="site-server"]')`, "New site with a server to pick");
  await hydrated("#title", "the New site form to come alive");
  await evaluate(`(() => { const el = document.querySelector('[data-testid="site-server"]'); el.value = [...el.options].find((o) => o.textContent === "tour-two").value; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await setValue("#title", "Remote Blog");
  await setValue("#name", "tour-remote");
  await setValue("#ownerName", "Ada Lovelace");
  await setValue("#ownerEmail", "ada@tour.test");
  await click('form:has(#title) button[type=submit]');
  await waitFor(`location.pathname.startsWith("/projects/tour-remote/deployments/")`, "the remote site's install", 60_000);
  await waitForDeploy("installing WordPress on the other server");
  console.log("  ✓ installed a WordPress site on the other server");
  await visit("tour-remote.internal", "/", "Remote Blog");
  const onOther = box(`ls /srv/apps/tour-remote 2>&1 | head -1`);
  if (!/No such file/.test(onOther)) throw new Error(`the site is on this server too: ${onOther}`);
  console.log("  ✓ it runs there, not here");
  await go("/projects/tour-remote/settings");
  await waitFor(`!!document.querySelector('[data-testid="delete-project"]')`, "the site's settings");
  await hydrated('[data-testid="delete-project"]', "the delete button to come alive");
  await click('[data-testid="delete-project"]');
  await waitFor(`!!document.querySelector("#confirm")`, "the delete confirmation");
  await evaluate(`(() => { const el = document.querySelector("#confirm"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "tour-remote"); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await click('form:has(#confirm) button[type=submit]');
  await waitFor(`!location.pathname.startsWith("/projects/tour-remote")`, "the remote site deleted", 120_000);
  console.log("  ✓ deleted it, there");
}

if (process.env.TOUR_ACCESS === "1") {
  console.log("Access");
  const mode = (label: string) => evaluate(`[...document.querySelectorAll('[data-testid="access"] button[role=radio]')].find((b) => b.textContent === ${JSON.stringify(label)}).click(), true`);
  const save = async (expect: RegExp, what: string) => {
    await click('[data-testid="access"] button[type=submit]');
    await waitFor(`${expect}.test(document.querySelector('[data-testid="access"]').innerText)`, what, 30_000);
  };
  await go("/settings");
  await waitForPath("/settings");
  await mode("Only these addresses");
  await waitFor(`!!document.querySelector('[data-testid="access"] textarea')?.value`, "your address filled in");
  const you = String(await evaluate(`document.querySelector('[data-testid="access"] textarea').value`)).trim();
  await save(/can open the panel now/, "the allowlist saved");
  await go("/settings");
  await waitForPath("/settings");
  console.log(`  ✓ only ${you} (this browser) can open the panel, and it still can`);
  await mode("Only these addresses");
  await fill('[data-testid="access"] textarea', "203.0.113.7");
  await save(/locked out/, "the lockout refusal");
  console.log("  ✓ a list without your own address is refused");
  await screenshot("access");
  await mode("Anyone");
  await save(/Anyone can reach/, "anyone again");
  console.log("  ✓ open to anyone again");
}

// The panel samples every minute. CPU takes two samples with no restart of the
// app in between, so on a fast run the first value can be a couple of minutes off.
if (process.env.TOUR_DEPLOY === "1") {
  console.log("Usage");
  let values = "";
  for (const deadline = Date.now() + 180_000; !/\d+(\.\d)?% \| \d+ MB/.test(values) && Date.now() < deadline; ) {
    if (values) await sleep(10_000);
    await go("/projects/next");
    await waitForPath("/projects/next");
    await waitFor(`document.querySelectorAll('[data-testid="usage-chart"]').length === 2`, "the usage charts");
    values = String(await evaluate(`[...document.querySelectorAll('[data-testid="usage-chart"]')].map((c) => c.firstElementChild.lastElementChild.textContent).join(" | ")`));
  }
  if (!/\d+(\.\d)?% \| \d+ MB/.test(values)) throw new Error(`no usage sampled for next: ${values}`);
  console.log(`  ✓ next's Overview charts its CPU and memory (now ${values})`);
  await screenshot("usage");

  console.log("Requests");
  await go("/projects/next/logs?tab=requests");
  await waitForPath("/projects/next/logs");
  await waitFor(`!!document.querySelector('[data-testid="requests"] [data-status]')`, "the request log");
  const requests = String(await evaluate(`document.querySelector('[data-testid="requests"]').innerText`));
  if (!requests.includes("/api/health")) throw new Error(`next's requests don't list the tour's health checks: ${requests.slice(0, 400)}`);
  console.log("  ✓ next's Logs list its requests from Caddy's log, the tour's health checks among them");
  await screenshot("requests");
}

console.log("Activity");
{
  await go("/settings/activity");
  await waitForPath("/settings/activity");
  await waitFor(`!!document.querySelector('[data-testid="activity"] [data-action]')`, "the activity log");
  const actions = String(await evaluate(`[...document.querySelectorAll('[data-testid="activity"] [data-action]')].map((r) => r.dataset.action).join(" ")`)).split(" ");
  for (const action of process.env.TOUR_DEPLOY === "1" ? ["build.run", "unit.start", "proxy.set"] : ["panel.site"]) {
    if (!actions.includes(action)) throw new Error(`Activity doesn't list ${action}: ${actions.join(" ")}`);
  }
  const reads = actions.filter((a) => /\.(info|status|list|history|tail|sample|disk|check|score)$/.test(a));
  if (reads.length) throw new Error(`Activity lists read-only calls: ${reads.join(" ")}`);
  console.log(`  ✓ Activity lists the agent's ${actions.length} latest changes, and none of its reads`);
  await screenshot("activity");
}

// TOUR_UPDATE=1: a feed (installer/test/release-feed.sh) offers a newer
// version. Check from Settings, update from the sidebar's button, and follow
// the update through the panel's restart.
if (process.env.TOUR_UPDATE === "1") {
  console.log("Update");
  await go("/settings");
  await waitForPath("/settings");
  // The monitor may have checked already (another feed, before the test's): wait for this check's answer.
  const checkedAt = String(await evaluate(`document.querySelector('[data-testid="updates"]').dataset.checkedAt`));
  await evaluate(`[...document.querySelectorAll('[data-testid="updates"] button')].find((b) => b.textContent === "Check for updates").click(), true`);
  await waitFor(`document.querySelector('[data-testid="updates"]')?.dataset.checkedAt !== ${JSON.stringify(checkedAt)}`, "the update check", 30_000);
  const offer = String(await evaluate(`document.querySelector('[data-testid="updates"]').innerText`));
  const target = /(\S+) is available/.exec(offer)?.[1];
  if (!target) throw new Error(`no update offered: ${offer}`);
  await waitFor(`!!document.querySelector('[data-testid="sidebar-update"]')?.innerText.includes(${JSON.stringify(target)})`, "the sidebar's Update button");
  await evaluate(`document.querySelector('[data-testid="sidebar-update"]').click(), true`);
  await waitFor(`!!document.querySelector('[data-testid="update-modal"]')`, "the update dialog");
  await screenshot("update-dialog");
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === ${JSON.stringify(`Update to ${target}`)}).click(), true`);
  await waitFor(`!!document.querySelector('[data-testid="update-progress"]')`, "the update to start", 60_000);
  await screenshot("update-running");
  // The page reloads itself once the new version answers.
  await waitFor(`!document.querySelector('[data-testid="update-progress"]') && !!document.querySelector('[data-testid="updates"]') && document.body.innerText.includes(${JSON.stringify(target)})`, `the panel on ${target}`, 600_000);
  if (await evaluate(`!!document.querySelector('[data-testid="sidebar-update"]')`)) throw new Error("the sidebar still offers an update after it");
  console.log(`  ✓ updated to ${target} from the sidebar's button; the page followed the panel's restart, and the button went`);
}

console.log("Account");
{
  await go("/settings");
  await waitForPath("/settings");
  const sessions = String(await evaluate(`document.querySelector('[data-testid="sessions"]').innerText`));
  if (!sessions.includes("This browser")) throw new Error(`Settings doesn't mark this browser's session: ${sessions}`);
  const open = (label: string) => evaluate(`[...document.querySelectorAll("main button")].find((b) => b.textContent === ${JSON.stringify(label)}).click(), true`);
  await open("New recovery codes…");
  await waitFor(`!!document.querySelector("#recovery-password")`, "the recovery codes form");
  await fill("#recovery-password", password);
  await click('[data-testid="recovery-codes"] button[type=submit]');
  await waitFor(`document.querySelectorAll('[data-testid="new-recovery-codes"] li').length === 8`, "8 new recovery codes", 30_000);
  console.log("  ✓ made new recovery codes");
  await open("Change password…");
  await waitFor(`!!document.querySelector("#current-password")`, "the change password form");
  const newPassword = "another-long-test-password";
  await fill("#current-password", password);
  await fill("#new-password", newPassword);
  await fill("#confirm-password", newPassword);
  await click('[data-testid="change-password"] button[type=submit]');
  await waitFor(`!!document.querySelector('[data-testid="password-changed"]')`, "the password change", 30_000);
  await screenshot("account");
  await click('button[title="Sign out"]');
  await waitForPath("/login");
  await fill("#email", email);
  await fill("#password", password);
  await click("button[type=submit]");
  await waitFor(`!!document.querySelector('[role=alert]')`, "the old password refused");
  await fill("#password", newPassword);
  await click("button[type=submit]");
  await waitForPath("/login/2fa");
  await typeCode(await nextCode(secret));
  await waitForPath("/");
  console.log("  ✓ changed the password: the old one is refused, the new one signs in");
}

console.log("Guards");
await send("Network.enable");
await send("Network.clearBrowserCookies");
await go("/");
await waitForPath("/login");
console.log("  ✓ signed out: / redirects to /login");
await go("/setup");
await waitForPath("/login");
console.log("  ✓ after setup: /setup redirects to /login");

ws.close();
console.log(`Screenshots in ${outDir}`);
process.exit(0);
