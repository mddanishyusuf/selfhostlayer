import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertSlug, ValidationError, type Color } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, ensureDir, lookupUser, writeFileAtomic } from "../fsutil.ts";
import { allocatePortPair } from "../ports.ts";
import { parseColorEnvPort, renderColorEnv, renderEnvFile } from "../templates/env-file.ts";
import { unitName } from "../templates/app-unit.ts";
import { parseLiveMarker } from "../templates/caddy-site.ts";

export function appLayout(ctx: Context, slug: string) {
  const appDir = childOf(ctx.paths.appsRoot, slug);
  const etcDir = childOf(ctx.paths.appEtcRoot, slug);
  return {
    user: `app-${slug}`,
    appDir,
    releases: join(appDir, "releases"),
    data: join(appDir, "data"),
    etcDir,
    appEnv: join(etcDir, "app.env"),
    colorEnv: (color: "blue" | "green") => join(etcDir, `${color}.env`),
  };
}

function readPorts(layout: ReturnType<typeof appLayout>) {
  const port = (color: "blue" | "green") => {
    const file = layout.colorEnv(color);
    return existsSync(file) ? parseColorEnvPort(readFileSync(file, "utf8")) : null;
  };
  return { blue: port("blue"), green: port("green") };
}

/**
 * Creates the app's Linux user, folders and env files, and allocates its
 * blue/green ports. Safe to repeat: existing pieces are kept as they are.
 */
async function appCreate(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const app = appLayout(ctx, slug);

  let user = await lookupUser(ctx.exec, app.user);
  const created = user === null;
  if (!user) {
    await ctx.exec(BIN.useradd, [
      "--system",
      "--user-group",
      "--shell", "/usr/sbin/nologin",
      "--home-dir", app.appDir,
      "--no-create-home",
      "--groups", ctx.paths.appsGroup,
      app.user,
    ]);
    user = await lookupUser(ctx.exec, app.user);
    if (!user) throw new Error(`useradd succeeded but ${app.user} doesn't exist`);
  }

  const owner = { uid: user.uid, gid: user.gid };
  ensureDir(app.appDir, 0o750, owner);
  ensureDir(app.releases, 0o750, owner);
  ensureDir(app.data, 0o700, owner);
  ensureDir(app.etcDir, 0o755);
  if (!existsSync(app.appEnv)) writeFileAtomic(app.appEnv, renderEnvFile({}), 0o600);

  let ports = readPorts(app);
  if (ports.blue === null || ports.green === null) {
    const [blue, green] = await allocatePortPair(ctx.paths.appEtcRoot, ctx.paths.portRange);
    writeFileAtomic(app.colorEnv("blue"), renderColorEnv(blue), 0o644);
    writeFileAtomic(app.colorEnv("green"), renderColorEnv(green), 0o644);
    ports = { blue, green };
  }

  return { slug, user: app.user, uid: user.uid, created, ports };
}

/**
 * Stops and removes everything app.create and later actions made. With
 * keepData (the default), data/ moves to the archive instead of being deleted.
 */
async function appDelete(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const keepData = params.keepData ?? true;
  if (typeof keepData !== "boolean") throw new ValidationError("keepData", "must be true or false");
  const app = appLayout(ctx, slug);

  const user = await lookupUser(ctx.exec, app.user);
  if (!user && !existsSync(app.appDir) && !existsSync(app.etcDir)) {
    throw new ActionError("not_found", `app ${slug} doesn't exist`);
  }

  // One unit per call: systemctl can give up on the whole batch when one of
  // them was never created.
  for (const unit of [`app-${slug}@blue.service`, `app-${slug}@green.service`, `layer-build-${slug}.service`]) {
    await ctx.exec(BIN.systemctl, ["stop", unit], { allowFail: true });
    await ctx.exec(BIN.systemctl, ["disable", unit], { allowFail: true });
  }
  const unitFile = join(ctx.paths.systemdDir, unitName(slug));
  if (existsSync(unitFile)) {
    rmSync(unitFile);
    await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  }
  const site = childOf(ctx.paths.caddySitesDir, `${slug}.caddy`);
  if (existsSync(site)) {
    rmSync(site);
    await ctx.exec(BIN.systemctl, ["reload", "caddy"], { allowFail: true });
  }

  let archivedData: string | null = null;
  if (keepData && existsSync(app.data)) {
    ensureDir(ctx.paths.archiveRoot, 0o700);
    archivedData = join(ctx.paths.archiveRoot, `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    try {
      renameSync(app.data, archivedData);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      cpSync(app.data, archivedData, { recursive: true, preserveTimestamps: true });
    }
  }

  if (user) {
    // Anything still running as the app user (a stray child process) would
    // make userdel fail.
    await ctx.exec(BIN.pkill, ["--signal", "KILL", "--uid", app.user], { allowFail: true });
    await ctx.exec(BIN.userdel, [app.user]);
  }
  rmSync(app.appDir, { recursive: true, force: true });
  rmSync(app.etcDir, { recursive: true, force: true });

  return { slug, deleted: true, archivedData };
}

/** Every app, read from /etc/layer/apps and the Caddy sites (no separate registry). */
async function appList(_params: Params, ctx: Context) {
  const root = ctx.paths.appEtcRoot;
  const slugs = existsSync(root) ? readdirSync(root).filter((s) => /^[a-z][a-z0-9-]*$/.test(s)).sort() : [];
  const apps = slugs.map((slug) => {
    const app = appLayout(ctx, slug);
    const site = childOf(ctx.paths.caddySitesDir, `${slug}.caddy`);
    const live: Color | null = existsSync(site) ? (parseLiveMarker(readFileSync(site, "utf8"))?.color ?? null) : null;
    const domains = existsSync(site) ? (/^([^#\s][^{]*)\{/m.exec(readFileSync(site, "utf8"))?.[1] ?? "").split(",").map((d) => d.trim()).filter(Boolean) : [];
    return {
      slug,
      ports: readPorts(app),
      live,
      domains,
      unitFile: existsSync(join(ctx.paths.systemdDir, unitName(slug))),
    };
  });
  return { apps };
}

export const appActions: ActionTable = {
  "app.list": { mutates: false, run: appList },
  "app.create": { mutates: true, run: appCreate },
  "app.delete": { mutates: true, run: appDelete },
};
