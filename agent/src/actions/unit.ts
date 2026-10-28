import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import {
  assertColor,
  assertHealthPath,
  assertInt,
  assertNodeVersion,
  assertSlug,
  COLORS,
  type Color,
} from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, ensureDir, writeFileAtomic } from "../fsutil.ts";
import { renderAppUnit, unitName } from "../templates/app-unit.ts";
import { parseLiveMarker } from "../templates/caddy-site.ts";
import { parseColorEnvPort } from "../templates/env-file.ts";
import { appLayout } from "./app.ts";

const instance = (slug: string, color: Color) => `app-${slug}@${color}.service`;

function requireApp(ctx: Context, slug: string) {
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  return app;
}

function requireUnitFile(ctx: Context, slug: string): string {
  const file = join(ctx.paths.systemdDir, unitName(slug));
  if (!existsSync(file)) throw new ActionError("not_found", `app ${slug} has no unit yet (run unit.write first)`);
  return file;
}

function colorPort(app: ReturnType<typeof appLayout>, color: Color): number {
  const port = existsSync(app.colorEnv(color)) ? parseColorEnvPort(readFileSync(app.colorEnv(color), "utf8")) : null;
  if (port === null) throw new ActionError("not_found", `no port for ${color} (run app.create first)`);
  return port;
}

/** The release a color points at, or null. */
function colorRelease(app: ReturnType<typeof appLayout>, color: Color): string | null {
  try {
    return basename(readlinkSync(join(app.appDir, color)));
  } catch {
    return null;
  }
}

export function liveColor(ctx: Context, slug: string): Color | null {
  const site = childOf(ctx.paths.caddySitesDir, `${slug}.caddy`);
  if (!existsSync(site)) return null;
  return parseLiveMarker(readFileSync(site, "utf8"))?.color ?? null;
}

async function unitWrite(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  requireApp(ctx, slug);
  const nodeVersion = assertNodeVersion(params.nodeVersion);
  if (!existsSync(join(ctx.paths.nodeRoot, nodeVersion, "bin", "node"))) {
    throw new ActionError("not_found", `Node ${nodeVersion} isn't installed (run node.install first)`);
  }
  const unit = renderAppUnit({
    slug,
    nodeVersion,
    exec: params.exec as string[],
    memoryMaxMb: (params.memoryMaxMb ?? 512) as number,
    cpuQuotaPercent: (params.cpuQuotaPercent ?? 100) as number,
    writablePaths: params.writablePaths as string[] | undefined,
    rootDir: params.rootDir === undefined || params.rootDir === "" ? undefined : (params.rootDir as string),
  });
  ensureDir(ctx.paths.systemdDir, 0o755);
  writeFileAtomic(join(ctx.paths.systemdDir, unitName(slug)), unit, 0o644);
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  return { slug, unit: unitName(slug) };
}

/**
 * (Re)starts one color and waits until it answers HTTP on its port. The color
 * is enabled, so it comes back after a reboot. If it never gets healthy it is
 * stopped again and the call fails with "unhealthy".
 */
async function unitStart(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const color = assertColor(params.color);
  const healthPath = assertHealthPath(params.healthPath ?? "/");
  const timeoutSec = assertInt(params.timeoutSec ?? 60, "timeoutSec", 1, 600);
  const app = requireApp(ctx, slug);
  requireUnitFile(ctx, slug);
  if (!colorRelease(app, color)) {
    throw new ActionError("no_release", `${color} doesn't point at a release yet (run release.point first)`);
  }
  const port = colorPort(app, color);
  const unit = instance(slug, color);

  await ctx.exec(BIN.systemctl, ["enable", unit], { allowFail: true });
  await ctx.exec(BIN.systemctl, ["restart", unit]);

  const started = Date.now();
  const deadline = started + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await answersHttp(port, healthPath)) {
      return { slug, color, port, healthy: true, readyMs: Date.now() - started };
    }
    const state = (await ctx.exec(BIN.systemctl, ["is-active", unit], { allowFail: true })).stdout.trim();
    if (state === "failed") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await ctx.exec(BIN.systemctl, ["stop", unit], { allowFail: true });
  await ctx.exec(BIN.systemctl, ["disable", unit], { allowFail: true });
  throw new ActionError(
    "unhealthy",
    `${unit} didn't answer on 127.0.0.1:${port}${healthPath} within ${timeoutSec}s (see: layer logs ${slug} --color ${color})`,
  );
}

/** Any HTTP answer below 500 counts: the app is up, even if / redirects or 404s. */
async function answersHttp(port: number, path: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

async function unitStop(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const color = assertColor(params.color);
  requireApp(ctx, slug);
  if (liveColor(ctx, slug) === color && params.force !== true) {
    throw new ActionError("conflict", `${color} is live for ${slug}: switch the proxy first (or pass force)`);
  }
  const unit = instance(slug, color);
  await ctx.exec(BIN.systemctl, ["stop", unit], { allowFail: true });
  await ctx.exec(BIN.systemctl, ["disable", unit], { allowFail: true });
  return { slug, color, stopped: true };
}

const SHOW_PROPS = ["ActiveState", "SubState", "MainPID", "MemoryCurrent", "NRestarts", "UnitFileState", "ActiveEnterTimestamp"];

async function unitStatus(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const app = requireApp(ctx, slug);
  const live = liveColor(ctx, slug);
  const colors: Record<string, unknown> = {};
  for (const color of COLORS) {
    const { stdout } = await ctx.exec(BIN.systemctl, ["show", instance(slug, color), ...SHOW_PROPS.map((p) => `-p${p}`)], {
      allowFail: true,
    });
    const props = Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    const memory = Number(props.MemoryCurrent);
    colors[color] = {
      state: props.ActiveState ?? "unknown",
      subState: props.SubState ?? "",
      enabled: props.UnitFileState === "enabled",
      pid: Number(props.MainPID) || null,
      memoryMb: Number.isFinite(memory) ? Math.round(memory / 2 ** 20) : null,
      restarts: Number(props.NRestarts) || 0,
      since: props.ActiveEnterTimestamp || null,
      release: colorRelease(app, color),
      port: colorPort(app, color),
      live: live === color,
    };
  }
  return { slug, live, unitFile: existsSync(join(ctx.paths.systemdDir, unitName(slug))), ...colors };
}

async function securityScore(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const color = assertColor(params.color ?? "blue");
  requireApp(ctx, slug);
  requireUnitFile(ctx, slug);
  const { stdout } = await ctx.exec(BIN.systemdAnalyze, ["security", instance(slug, color), "--no-pager"]);
  const match = /Overall exposure level for \S+: (\d+(?:\.\d+)?) (\w+)/.exec(stdout);
  if (!match) throw new Error("couldn't parse systemd-analyze security output");
  // 0 = fully locked down, 10 = fully exposed.
  return { slug, color, score: Number(match[1]), rating: match[2] };
}

export const unitActions: ActionTable = {
  "unit.write": { mutates: true, run: unitWrite },
  "unit.start": { mutates: true, run: unitStart },
  "unit.stop": { mutates: true, run: unitStop },
  "unit.status": { mutates: false, run: unitStatus },
  "security.score": { mutates: false, run: securityScore },
};
