// `layer`: the command-line view of the box, for when you SSH in. Every
// command goes through the agent, so it sees exactly what the panel sees.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AgentError, assertSlug, callAgent, isActionName } from "@layer/protocol";

const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2);
const bold = paint(1);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);

const HELP = `${bold("layer")}: Self Host Layer on this server

  layer ps                         apps, live color, ports, domains
  layer status <app>               blue/green state, release, memory, restarts
  layer logs <app> [-f] [-n 100] [--color blue|green]
  layer score <app> [--color blue|green]   systemd sandbox score (0 = safest)
  layer info                       server summary
  layer import <app> <file>        replace the app's data/ with a .tar.gz from another server
                                   (SQLite checked first; the replaced data is kept)
  layer access [reset]             who may open the panel; reset lets everyone reach the sign-in again
  layer update [version]           update the panel, agent and CLI from the release feed (apps keep running)
  layer repair                     put back generated files edited or deleted by hand (units, Caddy sites, env)
  layer call <action> [json]       send a raw agent action (debugging)

Raw commands behind these: journalctl -u 'app-<app>@*', systemctl status 'app-<app>@*',
/etc/caddy/sites/<app>.caddy, /etc/layer/apps/<app>/.`;

type Status = Record<string, any>;

const stateColor = (state: string) => (state === "active" ? green : state === "failed" ? red : state === "activating" ? yellow : dim);

function table(rows: string[][]): string {
  const strip = (s: string) => s.replace(/\x1b\[\d+m/g, "");
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => strip(r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => c + " ".repeat(widths[i]! - strip(c).length)).join("  ").trimEnd()).join("\n");
}

async function ps() {
  const { apps } = await callAgent<{ apps: Status[] }>("app.list");
  if (apps.length === 0) return console.log(dim("No apps yet."));
  const rows = [["APP", "LIVE", "BLUE", "GREEN", "DOMAINS"].map(bold)];
  for (const app of apps) {
    const status = app.unitFile ? await callAgent<Status>("unit.status", { slug: app.slug }) : null;
    const cell = (color: "blue" | "green") => {
      const s = status?.[color];
      const state = s?.state ?? "inactive";
      return `${stateColor(state)(state)} ${dim(`:${app.ports[color]}`)}`;
    };
    rows.push([bold(app.slug), app.live ?? dim("-"), cell("blue"), cell("green"), app.domains.join(", ") || dim("-")]);
  }
  console.log(table(rows));
}

async function status(slug: string) {
  const s = await callAgent<Status>("unit.status", { slug });
  console.log(`${bold(slug)}  live: ${s.live ? bold(s.live) : dim("none")}\n`);
  const rows = [["COLOR", "STATE", "RELEASE", "PORT", "MEMORY", "RESTARTS", "SINCE"].map(bold)];
  for (const color of ["blue", "green"] as const) {
    const c = s[color];
    rows.push([
      color + (c.live ? green(" ●") : ""),
      stateColor(c.state)(`${c.state}${c.subState && c.subState !== c.state ? `/${c.subState}` : ""}`),
      c.release ?? dim("-"),
      String(c.port),
      c.memoryMb === null ? dim("-") : `${c.memoryMb}MB`,
      String(c.restarts),
      c.since ?? dim("-"),
    ]);
  }
  console.log(table(rows));
}

async function logs(slug: string, opts: { follow: boolean; lines: number; color?: string }) {
  const params = { slug, lines: opts.lines, follow: opts.follow, ...(opts.color ? { color: opts.color } : {}) };
  if (!opts.follow) {
    const res = await callAgent<{ lines: string[] }>("logs.tail", params);
    return console.log(res.lines.join("\n") || dim("No log lines yet."));
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  await callAgent("logs.tail", params, { onChunk: (c) => process.stdout.write(c), signal: controller.signal }).catch((err) => {
    if (!(err instanceof AgentError && err.code === "aborted")) throw err;
  });
}

async function score(slug: string, color: string) {
  const s = await callAgent<Status>("security.score", { slug, color });
  const paintScore = s.score < 3 ? green : s.score < 6 ? yellow : red;
  console.log(`${bold(slug)} (${color}): ${paintScore(`${s.score} ${s.rating}`)}  ${dim("0 = fully sandboxed, 10 = fully exposed")}`);
}

async function info() {
  const i = await callAgent<Status>("system.info");
  console.log(table([
    [bold("server"), `${i.hostname}  ${i.os.name}  ${i.arch}  kernel ${i.kernel}`],
    [bold("cpu"), `${i.cpus} cores, load ${i.loadavg.join(" ")}`],
    [bold("memory"), `${i.memoryMb.available}MB free of ${i.memoryMb.total}MB, swap ${i.swapMb.total}MB`],
    [bold("disk"), `${i.diskGb.free}GB free of ${i.diskGb.total}GB`],
    [bold("node"), i.nodeVersions.join(", ")],
    [bold("caddy"), stateColor(i.caddy)(i.caddy)],
    [bold("agent"), i.agentVersion],
  ]));
}

// The agent only imports files the panel user owns in its restore folder
// (paths.restoreDir and paths.panelUser in the agent's config).
const RESTORE_DIR = "/var/lib/layer/restore";
const PANEL_USER = "layer";

const size = (bytes: number) => (bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`);

async function importData(slug: string, source: string) {
  assertSlug(slug);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`no such file: ${source}`);
  if (process.getuid?.() !== 0) throw new Error("run it as root (sudo layer import …): the archive is handed to the agent as the panel's file");
  const id = (flag: string) => Number(execFileSync("id", [flag, PANEL_USER], { encoding: "utf8" }).trim());
  const [uid, gid] = [id("-u"), id("-g")];
  mkdirSync(RESTORE_DIR, { recursive: true, mode: 0o700 });
  chownSync(RESTORE_DIR, uid, gid);
  const name = `${slug}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}.tar.gz`;
  const copy = join(RESTORE_DIR, name);
  copyFileSync(source, copy, constants.COPYFILE_EXCL);
  try {
    chownSync(copy, uid, gid);
    chmodSync(copy, 0o600);
    console.log(dim(`Importing ${source} into ${slug}…`));
    const r = await callAgent<{ previous: string; sqlite: { path: string }[]; files: number; bytes: number; restarted: string[] }>(
      "data.import",
      { slug, file: name },
      { onChunk: (c) => process.stdout.write(dim(c)) },
    );
    const checked = r.sqlite.length ? `, ${r.sqlite.length} SQLite database${r.sqlite.length === 1 ? "" : "s"} checked` : "";
    console.log(`${green("✓")} Imported ${r.files} file${r.files === 1 ? "" : "s"} (${size(r.bytes)})${checked}.${r.restarted.length ? " The app restarted on the new data." : ""}`);
    console.log(dim(`  The replaced data is kept in /srv/apps/${slug}/${r.previous} until the next import or restore.`));
  } finally {
    rmSync(copy, { force: true });
  }
}

async function access(sub: string | undefined) {
  if (sub === "reset") {
    await callAgent("panel.access", { allow: [] });
    return console.log(`${green("✓")} Anyone can reach the panel's sign-in page again (password and 2FA still apply).`);
  }
  if (sub !== undefined) throw new Error("usage: layer access [reset]");
  const box = JSON.parse(readFileSync("/etc/layer/config.json", "utf8")) as { panelHost: string; panelAllow?: string[] };
  const allow = box.panelAllow ?? [];
  if (!allow.length) return console.log(`${bold(box.panelHost)}: anyone can reach the sign-in page (password and 2FA still apply).`);
  console.log(`${bold(box.panelHost)} answers only from: ${allow.join(", ")}`);
  console.log(dim("  Locked out? `layer access reset` lets everyone reach the sign-in page again."));
}

async function repair() {
  const r = await callAgent<{ checked: number; restored: string[]; restarted: string[] }>("system.repair");
  if (!r.restored.length) return console.log(`${green("✓")} Nothing to repair: all ${r.checked} generated files are as the agent wrote them.`);
  console.log(`${green("✓")} Put back ${r.restored.length} file${r.restored.length === 1 ? "" : "s"} edited or deleted by hand:`);
  for (const path of r.restored) console.log(`  ${path}`);
  if (r.restarted.length) console.log(dim(`  Restarted ${r.restarted.join(", ")}`));
}

async function update(version: string | undefined) {
  const check = await callAgent<{ current: string; latest: { version: string; notes: string | null } | null; available: boolean; running: boolean }>("update.check");
  if (!version && !check.available) return console.log(`${green("✓")} ${check.current} is the latest version.`);
  const since = Math.floor(Date.now() / 1000);
  const started = await callAgent<{ from: string; to: string; unit: string }>("update.start", { version: version ?? "latest" }, { onChunk: (c) => process.stdout.write(dim(c)) });
  console.log(`Updating ${started.from} → ${bold(started.to)}. Your apps keep running.`);
  // The installer runs in its own unit (it restarts the agent): follow its output until it ends.
  const follow = spawn("journalctl", ["-u", started.unit, "-f", "-o", "cat", "--no-pager", `--since=@${since}`], { stdio: ["ignore", "inherit", "inherit"] });
  const show = (prop: string) => execFileSync("systemctl", ["show", started.unit, "-p", prop, "--value"], { encoding: "utf8" }).trim();
  await new Promise((r) => setTimeout(r, 1500));
  while (["active", "activating"].includes(show("ActiveState"))) await new Promise((r) => setTimeout(r, 1000));
  await new Promise((r) => setTimeout(r, 500));
  follow.kill();
  const now = (JSON.parse(readFileSync("/etc/layer/config.json", "utf8")) as { version: string }).version;
  if (show("Result") !== "success" || now !== started.to) throw new Error(`the update didn't finish (${show("Result")}); see journalctl -u ${started.unit}`);
  console.log(`${green("✓")} Updated to ${now}.`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      follow: { type: "boolean", short: "f", default: false },
      lines: { type: "string", short: "n", default: "100" },
      color: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, arg, extra] = positionals;
  const need = (what: string) => {
    if (!arg) throw new Error(`usage: layer ${command} <${what}>`);
    return arg;
  };

  switch (values.help ? "help" : command) {
    case "ps": return ps();
    case "status": return status(need("app"));
    case "logs": return logs(need("app"), { follow: values.follow, lines: Number(values.lines), color: values.color });
    case "score": return score(need("app"), values.color ?? "blue");
    case "info": return info();
    case "access": return access(arg);
    case "repair": return repair();
    case "update": return update(arg);
    case "import": {
      if (!arg || !extra) throw new Error("usage: layer import <app> <file.tar.gz>");
      return importData(arg, extra);
    }
    case "call": {
      const action = need("action");
      if (!isActionName(action)) throw new Error(`unknown action: ${action}`);
      return console.log(JSON.stringify(await callAgent(action, extra ? JSON.parse(extra) : {}), null, 2));
    }
    case undefined:
    case "help": return console.log(HELP);
    default: throw new Error(`unknown command: ${command} (try: layer help)`);
  }
}

main().catch((err) => {
  if (err instanceof AgentError && err.code === "connect_failed") {
    console.error(red("error:"), "can't reach the agent. Is it running? (systemctl status layer-agent). Run as root or with sudo.");
  } else {
    console.error(red("error:"), err instanceof AgentError ? `${err.message} (${err.code})` : (err as Error).message);
  }
  process.exit(1);
});
