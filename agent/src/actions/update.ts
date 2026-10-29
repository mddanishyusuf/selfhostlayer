// One-click updates. The release feed is named in /etc/layer/config.json
// (updatesUrl, set by the installer), so the panel can only choose a version,
// never where it comes from. The agent downloads the release and its
// installer, checks both checksums, and runs the installer in its own
// transient unit: the installer restarts the agent and the panel on the way.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { ensureDir } from "../fsutil.ts";
import { SYSTEMD_RUN } from "../sandbox.ts";
import { download } from "./node.ts";
import { readBox } from "./panel.ts";

export const UPDATE_UNIT = "layer-update.service";
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_FEED_BYTES = 1024 * 1024;

export interface Release {
  version: string;
  tarball: { url: string; sha256: string };
  installer: { url: string; sha256: string };
  date: string | null;
  notes: string | null;
}

/** https, or plain http to this box (tests serve a feed on 127.0.0.1). */
export function assertReleaseUrl(value: unknown, field: string): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new ValidationError(field, "must be a URL");
  }
  const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !local) throw new ValidationError(field, "must be an https URL");
  return url.href;
}

/** The feed's releases, newest first: { releases: [{ version, tarball: {url, sha256}, installer: {url, sha256}, date?, notes? }] }. */
export function parseFeed(text: string): Release[] {
  let feed: { releases?: unknown };
  try {
    feed = JSON.parse(text) as { releases?: unknown };
  } catch {
    throw new ActionError("bad_feed", "the update feed isn't JSON");
  }
  if (!Array.isArray(feed.releases)) throw new ActionError("bad_feed", "the update feed has no releases list");
  return feed.releases.map((r: Record<string, any>, i) => {
    const file = (f: unknown, name: string) => {
      const x = f as { url?: unknown; sha256?: unknown } | null;
      if (!x || typeof x.sha256 !== "string" || !SHA256.test(x.sha256)) throw new ValidationError(`releases[${i}].${name}.sha256`, "must be a sha256 in hex");
      return { url: assertReleaseUrl(x.url, `releases[${i}].${name}.url`), sha256: x.sha256 };
    };
    if (typeof r?.version !== "string" || !VERSION.test(r.version)) throw new ValidationError(`releases[${i}].version`, "must be a version like 0.2.0");
    return {
      version: r.version,
      tarball: file(r.tarball, "tarball"),
      installer: file(r.installer, "installer"),
      date: typeof r.date === "string" ? r.date.slice(0, 40) : null,
      notes: typeof r.notes === "string" ? r.notes.slice(0, 2000) : null,
    };
  });
}

async function readFeed(ctx: Context): Promise<Release[]> {
  const box = readBox(ctx);
  if (!box.updatesUrl) throw new ActionError("not_configured", "this server has no update feed (updatesUrl in /etc/layer/config.json)");
  const url = assertReleaseUrl(box.updatesUrl, "updatesUrl");
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new ActionError("download_failed", `couldn't reach the update feed (${(err as Error).message})`);
  }
  if (!res.ok) throw new ActionError("download_failed", `the update feed answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new ActionError("bad_feed", "the update feed is too big");
  return parseFeed(text);
}

async function running(ctx: Context): Promise<boolean> {
  const { stdout } = await ctx.exec(BIN.systemctl, ["is-active", UPDATE_UNIT], { allowFail: true });
  return ["active", "activating"].includes(stdout.trim());
}

async function updateCheck(_params: Params, ctx: Context) {
  const releases = await readFeed(ctx);
  const current = readBox(ctx).version;
  const latest = releases[0] ?? null;
  return {
    current,
    latest: latest && { version: latest.version, date: latest.date, notes: latest.notes },
    available: latest !== null && latest.version !== current,
    running: await running(ctx),
  };
}

async function updateStart(params: Params, ctx: Context, io: CallIO) {
  const releases = await readFeed(ctx);
  const wanted = params.version === "latest" ? releases[0]?.version : params.version;
  if (typeof wanted !== "string" || !VERSION.test(wanted)) throw new ValidationError("version", 'must be a version from the feed, or "latest"');
  const release = releases.find((r) => r.version === wanted);
  if (!release) throw new ActionError("not_found", `the update feed has no release ${wanted}`);
  if (await running(ctx)) throw new ActionError("busy", "an update is already running");

  // Only the release being installed is kept.
  if (existsSync(ctx.paths.updatesDir)) {
    for (const name of readdirSync(ctx.paths.updatesDir)) if (name !== release.version) rmSync(join(ctx.paths.updatesDir, name), { recursive: true, force: true });
  }
  const dir = join(ctx.paths.updatesDir, release.version);
  ensureDir(dir, 0o700);
  const tarball = join(dir, `layer-${release.version}.tar.gz`);
  const installer = join(dir, "install.sh");
  for (const [what, file, want] of [
    ["release", tarball, release.tarball],
    ["installer", installer, release.installer],
  ] as const) {
    io.emit(`Downloading the ${what} for ${release.version}…\n`);
    if ((await download(want.url, file)) !== want.sha256) {
      rmSync(dir, { recursive: true, force: true });
      throw new ActionError("checksum_mismatch", `the ${what} for ${release.version} doesn't match the checksum in the feed; nothing was installed`);
    }
  }

  await ctx.exec(BIN.systemctl, ["reset-failed", UPDATE_UNIT], { allowFail: true });
  // Its own unit, outside the agent: the installer restarts the agent and the panel.
  // Same settings as before (the installer keeps them in config.json); SSH is left alone.
  await ctx.exec(SYSTEMD_RUN, [
    "--quiet",
    `--unit=${UPDATE_UNIT}`,
    `--description=Self Host Layer update to ${release.version}`,
    "--",
    "/bin/bash",
    installer,
    "--from-tarball",
    tarball,
    "--yes",
    "--no-harden-ssh",
  ]);
  return { from: readBox(ctx).version, to: release.version, unit: UPDATE_UNIT };
}

async function updateStatus(_params: Params, ctx: Context) {
  const show = await ctx.exec(BIN.systemctl, ["show", UPDATE_UNIT, "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus"], { allowFail: true });
  const props = Object.fromEntries(show.stdout.trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  const log = await ctx.exec(BIN.journalctl, ["-u", UPDATE_UNIT, "-n", "40", "--no-pager", "-o", "cat"], { allowFail: true });
  return {
    running: ["active", "activating"].includes(props.ActiveState ?? ""),
    state: props.ActiveState ?? "inactive",
    result: props.Result ?? null,
    exitStatus: props.ExecMainStatus !== undefined ? Number(props.ExecMainStatus) : null,
    version: readBox(ctx).version,
    log: log.stdout.split("\n").filter(Boolean).slice(-40),
  };
}

export const updateActions: ActionTable = {
  "update.check": { mutates: false, run: updateCheck },
  "update.start": { mutates: true, run: updateStart },
  "update.status": { mutates: false, run: updateStatus },
};
