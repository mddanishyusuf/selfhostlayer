// Ghost for Sites: the `ghost` npm package (checked against the registry's
// sha512 integrity), unpacked as the site's user into a release, then built
// and run like any Node app (build.run with pnpm, unit.write, blue/green).
// Its database is MySQL 8 (mysql8.add); its content lives in data/content.
// ghost.setup makes the owner before the site is public. See PLAN-SITES.md.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertColor, assertLine, assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { ensureDir, lookupUser } from "../fsutil.ts";
import { sandboxArgs, SYSTEMD_RUN } from "../sandbox.ts";
import { parseColorEnvPort } from "../templates/env-file.ts";
import { appLayout } from "./app.ts";
import { download } from "./node.ts";

const assertGhostVersion = (v: unknown): string => {
  if (typeof v !== "string" || !/^\d{1,2}\.\d{1,3}\.\d{1,3}$/.test(v)) throw new ValidationError("version", "must be a Ghost version like 6.73.0");
  return v;
};

/**
 * Started by the unit instead of index.js: the color's PORT becomes Ghost's
 * server port, on 127.0.0.1 only, before Ghost reads its config.
 */
const STARTER = `// Written by Self Host Layer: starts Ghost on the port of its color, on 127.0.0.1.
process.env.server__port = process.env.PORT;
process.env.server__host = "127.0.0.1";
process.env.NODE_ENV = "production";
require("./index.js");
`;

/** Settings that never change for a site: content in data/, logs to the journal. */
const CONFIG = (contentPath: string) =>
  JSON.stringify(
    {
      paths: { contentPath },
      logging: { transports: ["stdout"], level: "info" },
      privacy: { useUpdateCheck: false },
    },
    null,
    2,
  ) + "\n";

async function registryVersion(version: string | undefined): Promise<{ version: string; tarball: string; integrity: string }> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://registry.npmjs.org/ghost/${version ?? "latest"}`, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const meta = (await res.json()) as { version?: string; dist?: { tarball?: string; integrity?: string } };
        const v = assertGhostVersion(meta.version);
        const tarball = meta.dist?.tarball ?? "";
        const integrity = meta.dist?.integrity ?? "";
        if (!tarball.startsWith(`https://registry.npmjs.org/ghost/-/ghost-${v}.tgz`) || !/^sha512-[A-Za-z0-9+/=]{80,100}$/.test(integrity)) throw new ActionError("download_failed", `the registry's answer for Ghost ${v} looks wrong`);
        return { version: v, tarball, integrity };
      }
      if (res.status === 404) throw new ActionError("not_found", `there's no Ghost ${version}`);
    } catch (err) {
      if (err instanceof ActionError) throw err;
    }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw new ActionError("download_failed", "couldn't reach registry.npmjs.org");
}

/** A sandboxed job as the site's user. */
async function job(ctx: Context, slug: string, command: string[], readWrite: string[], stdin?: NodeJS.ReadableStream) {
  const app = appLayout(ctx, slug);
  const user = await lookupUser(ctx.exec, app.user);
  if (!user) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  let output = "";
  const { code } = await ctx.spawn(
    SYSTEMD_RUN,
    sandboxArgs({ unit: `layer-site-${slug}.service`, user: user.name, cwd: app.appDir, readWrite, env: { PATH: "/usr/bin:/bin" }, memoryMb: 512, timeoutSec: 600, network: false, command }),
    { onData: (c) => (output += c), stdin: stdin as never },
  );
  return { code, output };
}

/**
 * Fetches Ghost (the newest, or a version given), checks it against the
 * registry's integrity hash, and unpacks it as the site into
 * releases/<sha1 of the tarball>, with the starter and its config. A site's
 * first release also gets Ghost's starting content (the Casper theme…) in
 * data/content. The release is then built with build.run (pnpm, --prod).
 */
async function ghostFetch(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  const meta = await registryVersion(params.version === undefined ? undefined : assertGhostVersion(params.version));
  ensureDir(ctx.paths.sitesCache, 0o755);
  const file = join(ctx.paths.sitesCache, `ghost-${meta.version}.tgz`);
  if (!existsSync(file)) {
    io.emit(`Downloading Ghost ${meta.version}…\n`);
    const tmp = `${file}.${randomBytes(4).toString("hex")}.part`;
    try {
      await download(meta.tarball, tmp);
      const actual = `sha512-${createHash("sha512").update(readFileSync(tmp)).digest("base64")}`;
      if (actual !== meta.integrity) throw new ActionError("checksum_mismatch", `Ghost ${meta.version} didn't match the registry's integrity hash, so it wasn't used`);
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  const release = createHash("sha1").update(readFileSync(file)).digest("hex");
  const dir = join(app.releases, release);
  if (existsSync(join(dir, "layer-ghost.js"))) return { slug, version: meta.version, release, fetched: false };

  io.emit(`Unpacking Ghost ${meta.version} as app-${slug}…\n`);
  const content = join(app.data, "content");
  const script = [
    "set -eu",
    'dir="$1" tmp="$1.unpacking" content="$2"',
    'rm -rf -- "$tmp"; mkdir -p -- "$tmp"',
    'tar --extract --gzip --file=- --no-same-owner --no-same-permissions --strip-components=1 --directory="$tmp"',
    // The first release seeds data/content (themes, the folders Ghost writes to).
    'if [ ! -d "$content" ]; then cp -R -- "$tmp/content" "$content"; fi',
    'printf "%s" "$3" >"$tmp/layer-ghost.js"',
    'printf "%s" "$4" >"$tmp/config.production.json"',
    'mv -- "$tmp" "$dir"',
  ].join("\n");
  const r = await job(ctx, slug, ["/bin/sh", "-c", script, "layer-ghost", dir, content, STARTER, CONFIG(content)], [app.releases, app.data], createReadStream(file));
  if (r.code !== 0) throw new ActionError("fetch_failed", `unpacking Ghost failed: ${r.output.trim().split("\n").at(-1) ?? ""}`);
  return { slug, version: meta.version, release, fetched: true };
}

const assertEmail = (v: unknown, field: string) => {
  const s = assertLine(v, field, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new ValidationError(field, "must be an email address");
  return s;
};

/**
 * Makes the owner through Ghost's own setup API, on the color that just
 * started and before Caddy sends anyone there: nobody else can claim the
 * site. The password is returned this once.
 */
async function ghostSetup(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const color = assertColor(params.color);
  const url = assertLine(params.url, "url", 300);
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(url)) throw new ValidationError("url", "must be the site's address, like https://blog.example.com");
  const title = assertLine(params.title, "title", 150);
  const name = assertLine(params.name, "name", 150);
  const email = assertEmail(params.email, "email");
  const app = appLayout(ctx, slug);
  const port = existsSync(app.colorEnv(color)) ? parseColorEnvPort(readFileSync(app.colorEnv(color), "utf8")) : null;
  if (!port) throw new ActionError("not_found", `no port for ${color}`);
  // Ghost wants 10+ characters and not an easy one.
  const password = `${randomBytes(15).toString("base64url")}-G7`;
  const base = `http://127.0.0.1:${port}/ghost/api/admin/authentication/setup/`;
  const headers = { "Content-Type": "application/json", Origin: url, "X-Forwarded-Proto": url.startsWith("https") ? "https" : "http", Host: new URL(url).host };
  const status = await fetch(base, { headers, signal: AbortSignal.timeout(30_000) }).then((r) => r.json() as Promise<{ setup?: { status?: boolean }[] }>).catch(() => null);
  if (status?.setup?.[0]?.status === true) throw new ActionError("conflict", `${slug} already has an owner`);
  const res = await fetch(base, { method: "POST", headers, body: JSON.stringify({ setup: [{ name, email, password, blogTitle: title }] }), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new ActionError("setup_failed", `Ghost's setup answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { slug, email, password };
}

export const ghostActions: ActionTable = {
  "ghost.fetch": { mutates: true, lock: "build", run: ghostFetch },
  "ghost.setup": { mutates: true, run: ghostSetup },
};
