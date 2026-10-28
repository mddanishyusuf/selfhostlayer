// `layer`: the command-line view of the box, for when you SSH in. Every
// command goes through the agent, so it sees exactly what the panel sees.
import { parseArgs } from "node:util";
import { AgentError, callAgent, isActionName } from "@layer/protocol";

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
