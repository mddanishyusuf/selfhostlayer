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
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--ignore-certificate-errors", `--remote-debugging-port=${port}`, `--user-data-dir=${join(outDir, ".chrome")}`, "about:blank"],
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
