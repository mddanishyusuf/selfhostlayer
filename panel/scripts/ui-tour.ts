// Drives headless Chrome through the whole panel flow (setup → 2FA → recovery
// codes → dashboard → sign out → sign in with 2FA) and saves a screenshot of
// every step. Doubles as a UI end-to-end check: it exits 1 if a step fails.
//
//   node panel/scripts/ui-tour.ts <base-url> <setup-token> <out-dir>
//
// Needs Google Chrome. Uses the DevTools protocol over Node's built-in WebSocket.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
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
async function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  const msg = await new Promise<any>((r) => pending.set(id, r));
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
await waitFor(`document.body.innerText.includes("Server") && !document.querySelector('[role=meter]') === false`, "dashboard data");
await screenshot("dashboard");
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
  await go("/new");
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
    const href = String(await evaluate(`document.querySelector('a[href^="/deployments/"]').getAttribute("href")`));
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
    await waitFor(`location.pathname.startsWith("/deployments/")`, "deployment page", 60_000);
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
  await waitFor(`location.pathname.startsWith("/deployments/")`, "redeploy page", 60_000);
  await waitForDeploy("redeploy");
  await go("/projects/next");
  await waitForPath("/projects/next");
  await click('button[title="Roll back to this deployment"]');
  await waitFor(`location.pathname.startsWith("/deployments/")`, "rollback page", 60_000);
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
  await waitFor(`document.body.innerText.includes("Next:")`, "next run shown", 30_000);
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

  // TOUR_DOMAIN: a host whose public DNS points at the box (e.g. shop.<ip-with-dashes>.sslip.io).
  const tourDomain = process.env.TOUR_DOMAIN;
  if (tourDomain) {
    console.log("Domains");
    await go("/projects/next/domains");
    await waitForPath("/projects/next/domains");
    await fill('input[name="host"]', tourDomain);
    await click('form:has(input[name="host"]) button[type=submit]');
    await waitFor(`document.body.innerText.includes("www.${tourDomain}")`, "domain rows", 60_000);
    // Both are live once DNS checks out: no Verify button left, a certificate status instead.
    await waitFor(`!document.querySelector('form:has(input[name="domainId"]) button[type=submit]')?.innerText.includes("Verify")`, "domains to go live", 60_000);
    const text = String(await evaluate("document.body.innerText"));
    if (!/Issuing certificate|expires in|local CA/.test(text)) throw new Error(`no certificate status shown:\n${text.slice(0, 600)}`);
    console.log(`  ✓ ${tourDomain} and www.${tourDomain} verified through public DNS and live`);
    await screenshot("domains-live");

    await fill('input[name="host"]', "github.com");
    await click('form:has(input[name="host"]) button[type=submit]');
    await waitFor(`document.body.innerText.includes("not this server")`, "wrong-IP explanation", 60_000);
    console.log("  ✓ a domain pointing elsewhere stays pending, with the explanation and the record to create");
    await screenshot("domains-pending");
    for (const host of ["github.com", "www.github.com"]) {
      await evaluate(`(() => {
        const row = [...document.querySelectorAll("a")].find((a) => a.textContent === ${JSON.stringify(host)})?.closest("div.grid");
        row?.querySelector('button[type=submit]:not([class*="bg-inverse"])')?.click();
        return true;
      })()`);
      await sleep(1500);
    }
    await go("/projects/next/domains");
    await waitForPath("/projects/next/domains");
    if (String(await evaluate("document.body.innerText")).includes("github.com")) throw new Error("removing the pending domain didn't work");
    console.log("  ✓ removed the pending domain");
  }

  console.log("Settings and delete");
  await go("/projects/vite/settings");
  await waitForPath("/projects/vite/settings");
  await screenshot("settings-vite");
  // React-controlled input: set the value through the native setter so React sees it.
  await evaluate(`(() => { const el = document.querySelector("#confirm"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "vite"); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await click('form:has(#confirm) button[type=submit]');
  await waitForPath("/");
  const overview = String(await evaluate("document.body.innerText"));
  if (/\bvite\b/.test(overview.split("Projects")[1] ?? "")) throw new Error("vite is still listed after deleting it");
  console.log("  ✓ deleted the vite project; it's gone from the overview");
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
