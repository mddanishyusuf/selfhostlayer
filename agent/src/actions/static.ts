// Static sites: copy a build's output folder to /srv/static/<slug>/<sha> and
// point /srv/static/<slug>/current at it. Caddy serves that with file_server.
//
// Caddy follows symlinks, so a symlink in the output pointing at, say,
// /var/lib/caddy would serve Caddy's own TLS keys. Therefore:
// - /srv/static/<slug>/ is root-owned: the app can never repoint `current`.
// - The copy runs as the app user (sandboxed) with `cp -L`, turning symlinks
//   into plain copies of what that user can read, and fails on anything that
//   isn't a regular file or folder. No sandbox has write access afterwards.
// - Then the agent hands the copy to root, checking again that it holds only
//   files and folders, so not even the app's own user could add a symlink later.
// - Release folders are setgid `caddy` (2750), so Caddy (and only Caddy) can read them.
import { randomBytes } from "node:crypto";
import { existsSync, lchownSync, lstatSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { assertFullSha, assertRelativePath, assertSlug } from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, ensureDir, lookupGid, lookupUser } from "../fsutil.ts";
import { sandboxArgs, SYSTEMD_RUN } from "../sandbox.ts";
import { appLayout } from "./app.ts";

const KEEP_STATIC_RELEASES = 3;

/** "." (the release itself) or a relative path like "dist". */
function assertOutputDir(value: unknown): string {
  return value === "." ? "." : assertRelativePath(value, "outputDir");
}

export const COPY_SCRIPT =
  'cp -rL -- "$1/." "$2/" || { echo "layer: copying $3 failed (missing folder, or a symlink to something this app can\'t read)"; exit 1; }; ' +
  'if [ -n "$(find "$2" ! -type f ! -type d -print -quit)" ]; then echo "layer: $3 contains special files (sockets, devices)"; exit 1; fi';

/**
 * Gives the published tree to uid (root in production), group Caddy. Nothing
 * writes there once the copy's unit has stopped, so lstat sees what Caddy
 * will serve: anything but files and folders fails the publish.
 */
function seal(dir: string, uid: number, gid: number, top = dir): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isDirectory()) seal(p, uid, gid, top);
    else if (!st.isFile()) throw new ActionError("publish_failed", `${p.slice(top.length + 1)} isn't a file or a folder; the live version is unchanged`);
    lchownSync(p, uid, gid);
  }
  if (dir === top) lchownSync(dir, uid, gid);
}

async function staticPublish(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const sha = assertFullSha(params.sha);
  const outputDir = assertOutputDir(params.outputDir);
  const rootDir = params.rootDir === undefined || params.rootDir === "" ? null : assertRelativePath(params.rootDir, "rootDir");
  const app = appLayout(ctx, slug);
  const user = await lookupUser(ctx.exec, app.user);
  if (!user) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  const release = join(app.releases, sha);
  if (!existsSync(release) || lstatSync(release).isSymbolicLink()) throw new ActionError("not_found", `release ${sha.slice(0, 7)} doesn't exist`);

  const gid = ctx.paths.staticGroup ? await lookupGid(ctx.exec, ctx.paths.staticGroup) : user.gid;
  if (gid === null) throw new Error(`group ${ctx.paths.staticGroup} doesn't exist`);
  ensureDir(ctx.paths.staticRoot, 0o711);
  const siteDir = childOf(ctx.paths.staticRoot, slug);
  // Owned by the agent itself (root in production), so the app can't repoint
  // `current`. 751: the app user may pass through to its own release folder;
  // only root and Caddy may list it.
  ensureDir(siteDir, 0o751, { uid: process.getuid?.() ?? 0, gid });
  // A new folder for every publish, even of the same commit (a redeploy after
  // an env change): the live folder is never touched until `current` switches,
  // so a failed publish can't take the site down. The random tail keeps two
  // publishes in the same millisecond from sharing (and deleting) one folder.
  const name = `${sha}-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const dest = join(siteDir, name);
  ensureDir(dest, 0o2750, { uid: user.uid, gid });

  const src = join(release, ...(rootDir ? [rootDir] : []), outputDir);
  const unit = `layer-publish-${slug}.service`;
  await ctx.exec(BIN.systemctl, ["reset-failed", unit], { allowFail: true });
  const { code } = await ctx.spawn(
    SYSTEMD_RUN,
    sandboxArgs({
      unit,
      user: user.name,
      cwd: release,
      readWrite: [dest],
      env: { PATH: "/usr/bin:/bin" },
      memoryMb: 512,
      timeoutSec: 600,
      network: false,
      command: ["/bin/sh", "-c", COPY_SCRIPT, "layer-publish", src, dest, outputDir],
    }),
    { onData: io.emit },
  );
  if (code !== 0) {
    rmSync(dest, { recursive: true, force: true });
    throw new ActionError("publish_failed", `publishing ${outputDir} failed (exit ${code}); the live version is unchanged`);
  }
  try {
    seal(dest, process.getuid?.() ?? 0, gid);
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }

  // Switch `current` atomically: a new symlink renamed over the old one.
  const tmp = join(siteDir, `.current-${randomBytes(4).toString("hex")}`);
  symlinkSync(name, tmp);
  renameSync(tmp, join(siteDir, "current"));

  // Keep the newest few published releases (fast rollback), never the live one.
  const old = readdirSync(siteDir)
    .filter((entry) => /^[0-9a-f]{40}-[0-9a-z]+$/.test(entry) && entry !== name)
    .map((entry) => ({ entry, mtimeMs: lstatSync(join(siteDir, entry)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(KEEP_STATIC_RELEASES - 1);
  for (const { entry } of old) rmSync(join(siteDir, entry), { recursive: true, force: true });

  return { slug, sha, root: join(siteDir, "current"), live: readlinkSync(join(siteDir, "current")) };
}

export const staticActions: ActionTable = {
  "static.publish": { mutates: true, lock: "build", run: staticPublish },
};
