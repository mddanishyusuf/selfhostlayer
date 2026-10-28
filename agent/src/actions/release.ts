import { lstatSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { assertColor, assertSha, assertSlug } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { appLayout } from "./app.ts";
import { liveColor } from "./unit.ts";

/**
 * Points /srv/apps/<slug>/<color> at releases/<sha>. The new symlink is made
 * beside the old one and renamed over it, so the switch is atomic. Running
 * processes keep their old working directory until restarted.
 */
async function releasePoint(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const color = assertColor(params.color);
  const sha = assertSha(params.sha);
  const app = appLayout(ctx, slug);

  const release = join(app.releases, sha);
  let isDir = false;
  try {
    isDir = lstatSync(release).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new ActionError("not_found", `release ${sha} doesn't exist for ${slug}`);
  if (liveColor(ctx, slug) === color && params.force !== true) {
    throw new ActionError("conflict", `${color} is live for ${slug}: point the idle color instead (or pass force)`);
  }

  const link = join(app.appDir, color);
  const tmp = join(app.appDir, `.${color}.${randomBytes(4).toString("hex")}`);
  symlinkSync(join("releases", sha), tmp);
  try {
    renameSync(tmp, link);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { slug, color, sha };
}

export const releaseActions: ActionTable = {
  "release.point": { mutates: true, run: releasePoint },
};
