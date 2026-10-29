// Drives headless Chrome through the whole panel flow (setup → 2FA → recovery
// codes → dashboard → sign out → sign in with 2FA) and saves a screenshot of
// every step. Doubles as a UI end-to-end check: it exits 1 if a step fails.
//
//   node panel/scripts/ui-tour.ts <base-url> <setup-token> <out-dir>
//
// Needs Google Chrome. Uses the DevTools protocol over Node's built-in WebSocket.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
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
async function typeCode(code: string) {
  await evaluate(`document.querySelector('input[aria-label="Digit 1"]').focus(), true`);
  await send("Input.insertText", { text: code });
}
const go = (path: string) => send("Page.navigate", { url: new URL(path, base).href });

const email = "admin@example.com";
const password = "a-long-test-password";
let lastCounter = 0;
/** A TOTP code for a step that hasn't been used yet (the panel refuses reuse). */
function nextCode(secret: string): string {
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
await typeCode(nextCode(secret));
await waitForPath("/setup/recovery");
await screenshot("recovery-codes");
await click("button[type=submit]");
await waitForPath("/");
await waitFor(`!!document.querySelector('button[title="Server status"]')`, "dashboard data");
await screenshot("dashboard");
await click('button[title="Server status"]');
await waitFor(`document.querySelectorAll('[role=dialog] [role=meter]').length === 3`, "server stats (CPU, memory, disk)");
await screenshot("server-modal");
await click('[role=dialog] button[aria-label="Close"]');
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
await typeCode(nextCode(secret));
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

// Deploys from github.com/mddanishyusuf/selfhostlayer-examples through the UI. TOUR_DEPLOY=1,
// TOUR_APPS_DOMAIN=<the box's appsDomain> (default "internal").
if (process.env.TOUR_DEPLOY === "1") {
  console.log("Deploy");
  const appsDomain = process.env.TOUR_APPS_DOMAIN ?? "internal";
  await setViewport(1280, 900);
  const headerText = `document.querySelector("main header")?.innerText ?? ""`;
  const waitForDeploy = async (what: string) => {
    await waitFor(`/\\b(Ready|Failed|Cancelled)\\b/.test(${headerText})`, `${what} to finish`, 15 * 60_000);
    const header = String(await evaluate(headerText));
    if (!header.includes("Ready")) {
      throw new Error(`${what} didn't succeed: ${header}\n${String(await evaluate(`document.querySelector('[role=log]')?.innerText ?? ""`)).slice(-1500)}`);
    }
  };
  const openNewestDeployment = async () => {
    const href = String(await evaluate(`document.querySelector('main a[href*="/deployments/"]').getAttribute("href")`));
    await go(href);
    await waitForPath(href);
    return href;
  };
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
  const setValue = (selector: string, value: string) =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
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
    await typeCode(nextCode(secret));
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

// TOUR_UPDATE=1: a feed (installer/test/release-feed.sh) offers a newer
// version; update from Settings and follow it through the panel's restart.
if (process.env.TOUR_UPDATE === "1") {
  console.log("Update");
  await go("/settings");
  await waitForPath("/settings");
  await evaluate(`[...document.querySelectorAll('[data-testid="updates"] button')].find((b) => b.textContent === "Check for updates").click(), true`);
  await waitFor(`/is available|latest version|role="alert"/.test(document.querySelector('[data-testid="updates"]').innerHTML)`, "the update check", 30_000);
  const offer = String(await evaluate(`document.querySelector('[data-testid="updates"]').innerText`));
  const target = /(\S+) is available/.exec(offer)?.[1];
  if (!target) throw new Error(`no update offered: ${offer}`);
  await evaluate(`[...document.querySelectorAll('[data-testid="updates"] button')].find((b) => b.textContent === ${JSON.stringify(`Update to ${target}`)}).click(), true`);
  await waitFor(`!!document.querySelector('[data-testid="update-progress"]')`, "the update to start", 60_000);
  await screenshot("update-running");
  // The page reloads itself once the new version answers.
  await waitFor(`!document.querySelector('[data-testid="update-progress"]') && !!document.querySelector('[data-testid="updates"]') && document.body.innerText.includes(${JSON.stringify(target)})`, `the panel on ${target}`, 600_000);
  console.log(`  ✓ updated to ${target} from Settings; the page followed the panel's restart`);
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
