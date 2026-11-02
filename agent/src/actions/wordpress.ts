// WordPress for Sites: core from wordpress.org (checked against its sha1),
// wp-cli as a pinned phar (sha512), the install and everything after it run
// as the site's own user in a sandbox. See PLAN-SITES.md.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, createReadStream, existsSync, readdirSync, readFileSync, readSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { assertLine, assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { ensureDir, lookupUser, removeManaged, writeFileAtomic } from "../fsutil.ts";
import { sandboxArgs, SYSTEMD_RUN } from "../sandbox.ts";
import {
  assertSiteUrl,
  assertWordpressVersion,
  MAIL_PLUGIN,
  newSalts,
  renderWpConfig,
  renderWpCronUnits,
  wordpressBlocks,
  wpCronUnitName,
  type WordpressMail,
  type WordpressState,
} from "../templates/wordpress.ts";
import { appLayout } from "./app.ts";
import { assertStagedName, openPanelFile } from "./backup.ts";
import { download } from "./node.ts";
import { phpAccess, phpInstalled, phpWrite } from "./php.ts";
import { readServices } from "./service.ts";

const DOCROOT = "wordpress";

const stateFile = (ctx: Context, slug: string) => join(appLayout(ctx, slug).etcDir, "wordpress.json");

export function wordpressState(ctx: Context, slug: string): WordpressState | null {
  try {
    return JSON.parse(readFileSync(stateFile(ctx, slug), "utf8")) as WordpressState;
  } catch {
    return null;
  }
}

const saveState = (ctx: Context, slug: string, state: WordpressState) => writeFileAtomic(stateFile(ctx, slug), JSON.stringify(state, null, 2) + "\n", 0o600);

const phar = (ctx: Context) => join(ctx.paths.toolsRoot, "wp-cli", ctx.paths.wpCli.version, "wp-cli.phar");
const coreTarball = (ctx: Context, version: string) => join(ctx.paths.sitesCache, `wordpress-${version}.tar.gz`);

/** Downloads to a temp file, checks it, then renames into place: a cached file is always a checked one. */
async function fetchChecked(url: string, target: string, check: (file: string) => boolean, what: string): Promise<void> {
  const tmp = `${target}.${randomBytes(4).toString("hex")}.part`;
  try {
    await download(url, tmp);
    if (!check(tmp)) throw new ActionError("checksum_mismatch", `${what} didn't match its checksum, so it wasn't used`);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const digest = (file: string, algo: "sha1" | "sha512") => createHash(algo).update(readFileSync(file)).digest("hex");

/** wp-cli, the pinned phar. */
async function ensureWpCli(ctx: Context): Promise<string> {
  const file = phar(ctx);
  if (existsSync(file)) return file;
  // Each level on its own: a recursive mkdir would leave the middle ones at the agent's umask (0700).
  ensureDir(join(ctx.paths.toolsRoot, "wp-cli"), 0o755);
  ensureDir(join(ctx.paths.toolsRoot, "wp-cli", ctx.paths.wpCli.version), 0o755);
  await fetchChecked(ctx.paths.wpCli.url, file, (f) => digest(f, "sha512") === ctx.paths.wpCli.sha512, `wp-cli ${ctx.paths.wpCli.version}`);
  // Every site's user runs it.
  chmodSync(file, 0o644);
  return file;
}

/** A small text from wordpress.org, tried 3 times: a dropped connection shouldn't fail an install. */
async function getText(url: string): Promise<string> {
  let last = "";
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) return await res.text();
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error & { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw new ActionError("download_failed", `couldn't reach ${new URL(url).host} (${last})`);
}

/** The newest WordPress already downloaded and checked, if any. */
function newestCached(ctx: Context): string | null {
  if (!existsSync(ctx.paths.sitesCache)) return null;
  const versions = readdirSync(ctx.paths.sitesCache)
    .map((n) => /^wordpress-(\d+\.\d+(?:\.\d+)?)\.tar\.gz$/.exec(n)?.[1])
    .filter((v): v is string => !!v);
  const key = (v: string) => v.split(".").map((n) => n.padStart(4, "0")).join(".");
  return versions.sort((a, b) => key(b).localeCompare(key(a)))[0] ?? null;
}

/** WordPress core, the newest (from wordpress.org's version check) or a version given. Its sha1 comes from wordpress.org too. */
async function wordpressFetch(params: Params, ctx: Context) {
  let version: string;
  if (params.version === undefined) {
    try {
      const offer = (JSON.parse(await getText("https://api.wordpress.org/core/version-check/1.7/")) as { offers?: { version?: string }[] }).offers?.[0]?.version;
      version = assertWordpressVersion(offer);
    } catch (err) {
      // Offline for a moment: the newest checked copy here does.
      const cached = newestCached(ctx);
      if (!cached) throw err;
      version = cached;
    }
  } else version = assertWordpressVersion(params.version);
  await ensureWpCli(ctx);
  const file = coreTarball(ctx, version);
  if (existsSync(file)) return { version, cached: true };
  ensureDir(ctx.paths.sitesCache, 0o755);
  const sha1 = (await getText(`https://wordpress.org/wordpress-${version}.tar.gz.sha1`)).trim();
  if (!/^[0-9a-f]{40}$/.test(sha1)) throw new ActionError("download_failed", `wordpress.org has no checksum for WordPress ${version}`);
  await fetchChecked(`https://wordpress.org/wordpress-${version}.tar.gz`, file, (f) => digest(f, "sha1") === sha1, `WordPress ${version}`);
  return { version, cached: false };
}

/** A sandboxed job as the site's user. */
async function job(ctx: Context, slug: string, command: string[], opts: { stdin?: Readable; network?: boolean | "localhost"; io?: CallIO; timeoutSec?: number } = {}) {
  const app = appLayout(ctx, slug);
  const user = await lookupUser(ctx.exec, app.user);
  if (!user) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  let output = "";
  const { code } = await ctx.spawn(
    SYSTEMD_RUN,
    sandboxArgs({
      unit: `layer-site-${slug}.service`,
      user: user.name,
      cwd: app.data,
      readWrite: [app.data],
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp", WP_CLI_CACHE_DIR: "/tmp/wp-cli" },
      memoryMb: 512,
      timeoutSec: opts.timeoutSec ?? 600,
      network: opts.network ?? false,
      command,
    }),
    {
      onData: (chunk) => {
        output += chunk;
        opts.io?.emit(chunk);
      },
      stdin: opts.stdin,
    },
  );
  return { code, output };
}

/** wp-cli as the site's user: MariaDB on 127.0.0.1, and the internet only when asked (updates). */
function wp(ctx: Context, slug: string, args: string[], opts: { stdin?: Readable; internet?: boolean; io?: CallIO } = {}) {
  const docroot = join(appLayout(ctx, slug).data, DOCROOT);
  return job(ctx, slug, ["/usr/bin/php", "-d", "memory_limit=512M", phar(ctx), `--path=${docroot}`, "--no-color", ...args], { stdin: opts.stdin, network: opts.internet ? true : "localhost", io: opts.io });
}

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).at(-1) ?? "";

/** Files written into the docroot as the site (wp-config.php 600, others 640), never through a symlink. */
const WRITE_JOB = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  for (const f of JSON.parse(input)) {
    const target = path.join(root, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
    const tmp = target + ".layer-tmp";
    fs.rmSync(tmp, { force: true });
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, f.mode);
    fs.writeSync(fd, f.content);
    fs.closeSync(fd);
    fs.renameSync(tmp, target);
  }
});
`;

async function writeSiteFiles(ctx: Context, slug: string, files: { path: string; content: string; mode: number }[]): Promise<void> {
  const docroot = join(appLayout(ctx, slug).data, DOCROOT);
  const r = await job(ctx, slug, [ctx.paths.runtimeNode, "--no-warnings", "-e", WRITE_JOB, docroot], { stdin: Readable.from([JSON.stringify(files)]) });
  if (r.code !== 0) throw new ActionError("write_failed", `writing ${slug}'s WordPress files failed: ${lastLine(r.output)}`);
}

/** wp-config.php and the mail plugin, from the state and the site's MariaDB. */
async function writeConfig(ctx: Context, slug: string, state: WordpressState): Promise<void> {
  const db = readServices(ctx, slug).mysql;
  if (!db) throw new ActionError("not_installed", `${slug} has no MySQL database yet (mysql.add)`);
  await writeSiteFiles(ctx, slug, [
    { path: "wp-config.php", content: renderWpConfig(state, db), mode: 0o600 },
    { path: "wp-content/mu-plugins/layer-mail.php", content: MAIL_PLUGIN, mode: 0o640 },
  ]);
}

async function writeCron(ctx: Context, slug: string): Promise<void> {
  const units = renderWpCronUnits(slug, phar(ctx));
  const name = wpCronUnitName(slug);
  writeFileAtomic(join(ctx.paths.systemdDir, `${name}.service`), units.service, 0o644);
  writeFileAtomic(join(ctx.paths.systemdDir, `${name}.timer`), units.timer, 0o644);
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  await ctx.exec(BIN.systemctl, ["enable", "--now", `${name}.timer`]);
}

const assertName = (v: unknown, field: string) => {
  const s = assertLine(v, field, 60);
  if (!/^[A-Za-z0-9._@-]{1,60}$/.test(s)) throw new ValidationError(field, "must be letters, digits, . _ @ or -");
  return s;
};
const assertEmail = (v: unknown, field: string) => {
  const s = assertLine(v, field, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new ValidationError(field, "must be an email address");
  return s;
};

/**
 * Installs WordPress into an app made for it (app.create, mysql.add): core
 * unpacked as the site, wp-config.php, its PHP, then `wp core install` with
 * the owner made at once: nobody else can claim a fresh site. The owner's
 * password is returned this once.
 */
async function wordpressInstall(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const version = assertWordpressVersion(params.version);
  const url = assertSiteUrl(params.url);
  const title = assertLine(params.title, "title", 200);
  const adminUser = assertName(params.adminUser, "adminUser");
  const adminEmail = assertEmail(params.adminEmail, "adminEmail");
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  if (!phpInstalled(ctx)) throw new ActionError("not_installed", "PHP isn't installed yet (service.install php)");
  if (!readServices(ctx, slug).mysql) throw new ActionError("not_installed", `${slug} has no MySQL database yet (mysql.add)`);
  const tarball = coreTarball(ctx, version);
  if (!existsSync(tarball) || !existsSync(phar(ctx))) throw new ActionError("not_found", `WordPress ${version} isn't downloaded yet (wordpress.fetch)`);
  if (existsSync(join(app.data, DOCROOT, "wp-load.php"))) throw new ActionError("conflict", `${slug} already has WordPress`);

  io.emit(`Unpacking WordPress ${version} as app-${slug}…\n`);
  const docroot = join(app.data, DOCROOT);
  const unpack = await job(ctx, slug, ["/bin/sh", "-c", 'mkdir -p -- "$1" && tar --extract --gzip --file=- --no-same-owner --no-same-permissions --strip-components=1 --directory="$1"', "layer-unpack", docroot], {
    stdin: createReadStream(tarball),
  });
  if (unpack.code !== 0) throw new ActionError("install_failed", `unpacking WordPress failed: ${lastLine(unpack.output)}`);

  const state: WordpressState = wordpressState(ctx, slug) ?? { version, url, salts: newSalts(), locked: false, xmlrpc: false, mail: null };
  Object.assign(state, { version, url });
  saveState(ctx, slug, state);
  await writeConfig(ctx, slug, state);
  io.emit("Starting its PHP…\n");
  await phpWrite({ slug, root: DOCROOT, private: ["wp-config.php"], ...(params.memoryMaxMb === undefined ? {} : { memoryMaxMb: params.memoryMaxMb }) }, ctx);

  io.emit("Installing, with the owner's account…\n");
  const password = randomBytes(18).toString("base64url");
  const install = await wp(ctx, slug, ["core", "install", `--url=${url}`, `--title=${title}`, `--admin_user=${adminUser}`, `--admin_email=${adminEmail}`, "--skip-email", "--prompt=admin_password"], {
    stdin: Readable.from([`${password}\n`]),
  });
  if (install.code !== 0) throw new ActionError("install_failed", `wp core install failed: ${lastLine(install.output)}`);
  // Pretty links: WordPress's own default for new sites.
  await wp(ctx, slug, ["rewrite", "structure", "/%postname%/"]);
  await writeCron(ctx, slug);
  await phpAccess(ctx, slug);
  return { slug, version, url, adminUser, adminPassword: password, block: wordpressBlocks(state.xmlrpc) };
}

const assertMail = (v: unknown): WordpressMail | null => {
  if (v === null) return null;
  const m = (v ?? {}) as Record<string, unknown>;
  if (m.kind === "api") {
    // Email's API takes "Name <hello@example.com>" too.
    const from = assertLine(m.from, "mail.from", 200);
    if (!/^([^<>\r\n"']{1,100} )?<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(from)) {
      // The message apart: the bundle check would read `from", "…"` as an import.
      const message = "must be an address, or Name <address>";
      throw new ValidationError("mail.from", message);
    }
    return { kind: "api", url: assertSiteUrl(String(m.url ?? "").replace(/\/+$/, ""), "mail.url"), key: assertLine(m.key, "mail.key", 200), from };
  }
  const from = assertEmail(m.from, "mail.from");
  if (m.kind === "smtp") {
    const secure = m.secure ?? "";
    if (secure !== "" && secure !== "tls" && secure !== "ssl") throw new ValidationError("mail.secure", 'must be "", "tls" or "ssl"');
    const port = Number(m.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("mail.port", "must be a port");
    return { kind: "smtp", host: assertLine(m.host, "mail.host", 253), port, user: assertLine(m.user ?? "", "mail.user", 200), password: assertLine(m.password ?? "", "mail.password", 200), secure, from };
  }
  throw new ValidationError("mail.kind", 'must be "api" or "smtp"');
};

/** Settings the panel changes: the address, Lock code, XML-RPC, mail. wp-config.php is written again. */
async function wordpressConfig(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const state = wordpressState(ctx, slug);
  if (!state) throw new ActionError("not_found", `${slug} isn't a WordPress site`);
  if (params.url !== undefined) state.url = assertSiteUrl(params.url);
  for (const key of ["locked", "xmlrpc"] as const) {
    if (params[key] === undefined) continue;
    if (typeof params[key] !== "boolean") throw new ValidationError(key, "must be true or false");
    state[key] = params[key];
  }
  if (params.mail !== undefined) state.mail = assertMail(params.mail);
  saveState(ctx, slug, state);
  await writeConfig(ctx, slug, state);
  return { slug, url: state.url, locked: state.locked, xmlrpc: state.xmlrpc, mail: state.mail ? { kind: state.mail.kind, from: state.mail.from } : null, block: wordpressBlocks(state.xmlrpc) };
}

/** Sections of one status job's output. wp-cli's JSON has no newline at its end, so each marker gets its own line. */
const STATUS_SCRIPT = [
  'p="$1" d="$2"',
  'w() { /usr/bin/php -d memory_limit=512M "$p" --path="$d" --no-color --skip-plugins --skip-themes "$@"; }',
  'echo; echo "::version"; w core version',
  'echo; echo "::core"; w core check-update --format=json',
  'echo; echo "::plugins"; w plugin list --format=json --fields=name,title,status,version,update,update_version',
  'echo; echo "::themes"; w theme list --format=json --fields=name,title,status,version,update,update_version',
  'echo; echo "::end"',
].join("\n");

function section(output: string, name: string): string {
  const m = new RegExp(`::${name}\\n([\\s\\S]*?)\\n::`).exec(output);
  return m?.[1]?.trim() ?? "";
}
const parseJson = <T>(s: string, fallback: T): T => {
  try {
    return s ? (JSON.parse(s.split("\n").filter((l) => l.startsWith("[") || l.startsWith("{")).at(-1) ?? "") as T) : fallback;
  } catch {
    return fallback;
  }
};

/** The version, core updates, and plugins and themes with their updates (wordpress.org is asked). */
async function wordpressStatus(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const state = wordpressState(ctx, slug);
  if (!state) throw new ActionError("not_found", `${slug} isn't a WordPress site`);
  const docroot = join(appLayout(ctx, slug).data, DOCROOT);
  const r = await job(ctx, slug, ["/bin/sh", "-c", STATUS_SCRIPT, "layer-status", phar(ctx), docroot], { network: true, timeoutSec: 180 });
  const version = section(r.output, "version").split("\n").at(-1) ?? null;
  const core = parseJson<{ version: string; update_type: string }[]>(section(r.output, "core"), []);
  type Item = { name: string; title: string; status: string; version: string; update: string; update_version: string };
  const plugins = parseJson<Item[]>(section(r.output, "plugins"), []);
  const themes = parseJson<Item[]>(section(r.output, "themes"), []);
  return {
    slug,
    version: version && /^\d/.test(version) ? version : null,
    coreUpdate: core[0]?.version ?? null,
    plugins: plugins.map((p) => ({ name: p.name, title: p.title, status: p.status, version: p.version, update: p.update === "available" ? p.update_version : null })),
    themes: themes.map((t) => ({ name: t.name, title: t.title, status: t.status, version: t.version, update: t.update === "available" ? t.update_version : null })),
    url: state.url,
    locked: state.locked,
    xmlrpc: state.xmlrpc,
    mail: state.mail ? { kind: state.mail.kind, from: state.mail.from } : null,
    php: phpInstalled(ctx)?.version ?? null,
  };
}

/**
 * The few wp-cli commands the panel runs, never any other: updates, a new
 * password for a user (returned this once), and search-replace after the
 * address changes.
 */
async function wordpressRun(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const state = wordpressState(ctx, slug);
  if (!state) throw new ActionError("not_found", `${slug} isn't a WordPress site`);
  const op = params.op;
  const run = async (args: string[], opts: { stdin?: Readable; internet?: boolean } = {}) => {
    const r = await wp(ctx, slug, args, { ...opts, io });
    if (r.code !== 0) throw new ActionError("wp_failed", `wp ${args.slice(0, 2).join(" ")} failed: ${lastLine(r.output)}`);
    return r.output;
  };
  // Lock code stops updates from wp-admin; the panel's updates (backed up first) still run.
  const unlocked = ["--skip-plugins", "--skip-themes"];
  switch (op) {
    case "update-core": {
      await run(["core", "update", ...unlocked], { internet: true });
      await run(["core", "update-db", ...unlocked]);
      const version = lastLine(await run(["core", "version", ...unlocked]));
      if (/^\d/.test(version)) saveState(ctx, slug, { ...state, version });
      return { slug, op, version };
    }
    case "update-plugins":
      await run(["plugin", "update", "--all", ...unlocked], { internet: true });
      return { slug, op };
    case "update-themes":
      await run(["theme", "update", "--all", ...unlocked], { internet: true });
      return { slug, op };
    case "reset-password": {
      const user = assertName(params.user, "user");
      const password = randomBytes(18).toString("base64url");
      await run(["user", "update", user, "--prompt=user_pass", "--skip-email", ...unlocked], { stdin: Readable.from([`${password}\n`]) });
      return { slug, op, user, password };
    }
    case "search-replace": {
      const from = assertSiteUrl(params.from, "from");
      const to = assertSiteUrl(params.to, "to");
      const out = await run(["search-replace", from, to, "--all-tables-with-prefix", "--skip-columns=guid", "--format=count", ...unlocked]);
      return { slug, op, replaced: Number(lastLine(out)) || 0 };
    }
    default:
      throw new ValidationError("op", 'must be "update-core", "update-plugins", "update-themes", "reset-password" or "search-replace"');
  }
}

/**
 * Brings an existing WordPress in, from an archive (.tar.gz, .tar or .zip)
 * holding its wp-content folder and a .sql dump, as most backup plugins make.
 * Everything runs as the site: unpack, then the dump into its own database
 * (with the dump's table prefix), then wp-content swapped in (the old one
 * kept as wordpress/wp-content.before-import) and the old address replaced by
 * this site's. wp-config.php stays generated (this site's database and salts).
 */
const IMPORT_UNPACK = [
  "set -eu",
  'work="$1" kind="$2"',
  'rm -rf -- "$work"; mkdir -p -- "$work/x"',
  'case "$kind" in',
  '  zip) cat >"$work/in.zip"; unzip -q "$work/in.zip" -d "$work/x"; rm -f -- "$work/in.zip" ;;',
  '  gzip) tar --extract --gzip --file=- --no-same-owner --no-same-permissions --directory="$work/x" ;;',
  '  *) tar --extract --file=- --no-same-owner --no-same-permissions --directory="$work/x" ;;',
  "esac",
  'content="$(find "$work/x" -maxdepth 4 -type d -name wp-content -not -path "*/wp-content/*" | head -n 1)"',
  'sql="$(find "$work/x" -maxdepth 4 -type f -name "*.sql" | head -n 1)"',
  'if [ -z "$content" ]; then echo "layer: the archive has no wp-content folder"; exit 3; fi',
  'if [ -z "$sql" ]; then echo "layer: the archive has no .sql dump of the database"; exit 3; fi',
  // Single quotes: in double quotes the dump's backticks would run as commands.
  "prefix=\"$(grep -m 1 -oE 'CREATE TABLE (IF NOT EXISTS )?.[A-Za-z0-9_]+options.' \"$sql\" | sed -E 's/^CREATE TABLE (IF NOT EXISTS )?.([A-Za-z0-9_]*)options.$/\\2/')\"",
  'echo "LAYER-IMPORT content=$content"',
  'echo "LAYER-IMPORT sql=$sql"',
  'echo "LAYER-IMPORT prefix=${prefix:-wp_}"',
].join("\n");

const IMPORT_SWAP = [
  "set -eu",
  'root="$1" content="$2"',
  'rm -rf -- "$root/wp-content.before-import"',
  'mv -- "$root/wp-content" "$root/wp-content.before-import"',
  'mv -- "$content" "$root/wp-content"',
  // The mail plugin is the server's, not the old site's.
  'mkdir -p -- "$root/wp-content/mu-plugins"',
  'cp -- "$root/wp-content.before-import/mu-plugins/layer-mail.php" "$root/wp-content/mu-plugins/layer-mail.php"',
].join("\n");

async function wordpressImport(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const name = assertStagedName(params.file, "file");
  const state = wordpressState(ctx, slug);
  if (!state) throw new ActionError("not_found", `${slug} isn't a WordPress site`);
  const app = appLayout(ctx, slug);
  const fd = await openPanelFile(ctx, name);
  const head = Buffer.alloc(262);
  readSync(fd, head, 0, head.length, 0);
  const kind = head[0] === 0x50 && head[1] === 0x4b ? "zip" : head[0] === 0x1f && head[1] === 0x8b ? "gzip" : head.subarray(257, 262).toString("latin1") === "ustar" ? "tar" : null;
  if (!kind) {
    closeSync(fd);
    throw new ActionError("bad_archive", "the file isn't a .zip, .tar.gz or .tar");
  }
  const work = join(app.data, `wordpress-import-${randomBytes(4).toString("hex")}`);
  try {
    io.emit("Unpacking the archive as the site…\n");
    const unpack = await job(ctx, slug, ["/bin/sh", "-c", IMPORT_UNPACK, "layer-import", work, kind], { stdin: createReadStream("", { fd, autoClose: false }) });
    const said = (k: string) => new RegExp(`^LAYER-IMPORT ${k}=(.+)$`, "m").exec(unpack.output)?.[1]?.trim();
    if (unpack.code !== 0) throw new ActionError("import_failed", lastLine(unpack.output).replace(/^layer: /, ""));
    const content = said("content");
    const sql = said("sql");
    const prefix = said("prefix") ?? "wp_";
    if (!content?.startsWith(`${work}/`) || !sql?.startsWith(`${work}/`)) throw new ActionError("import_failed", "the archive's layout couldn't be read");
    if (!/^[A-Za-z0-9_]{1,20}$/.test(prefix)) throw new ActionError("import_failed", `the dump's table prefix (${prefix}) isn't one WordPress takes`);

    io.emit(`Loading the database (tables ${prefix}*)…\n`);
    const before = state.tablePrefix;
    saveState(ctx, slug, { ...state, tablePrefix: prefix });
    await writeConfig(ctx, slug, { ...state, tablePrefix: prefix });
    const loaded = await wp(ctx, slug, ["db", "import", sql, "--skip-plugins", "--skip-themes"]);
    if (loaded.code !== 0) {
      saveState(ctx, slug, { ...state, tablePrefix: before });
      await writeConfig(ctx, slug, state);
      throw new ActionError("import_failed", `the dump didn't load: ${lastLine(loaded.output)}`);
    }
    // From the table, not `wp option get`: wp-config.php's WP_SITEURL would answer instead.
    const oldUrl = lastLine((await wp(ctx, slug, ["db", "query", `SELECT option_value FROM ${prefix}options WHERE option_name = 'siteurl'`, "--skip-column-names", "--skip-plugins", "--skip-themes"])).output).replace(/\/+$/, "");

    io.emit("Putting its wp-content in place…\n");
    const docroot = join(app.data, DOCROOT);
    const swap = await job(ctx, slug, ["/bin/sh", "-c", IMPORT_SWAP, "layer-import", docroot, content]);
    if (swap.code !== 0) throw new ActionError("import_failed", `wp-content couldn't be swapped in: ${lastLine(swap.output)}`);

    let replaced = 0;
    if (/^https?:\/\//.test(oldUrl) && oldUrl !== state.url) {
      io.emit(`Replacing ${oldUrl} with ${state.url}…\n`);
      const r = await wp(ctx, slug, ["search-replace", oldUrl, state.url, "--all-tables-with-prefix", "--skip-columns=guid", "--format=count", "--skip-plugins", "--skip-themes"]);
      replaced = Number(lastLine(r.output)) || 0;
    }
    await wp(ctx, slug, ["cache", "flush", "--skip-plugins", "--skip-themes"]);
    await wp(ctx, slug, ["rewrite", "flush", "--skip-plugins", "--skip-themes"]);
    await phpAccess(ctx, slug);
    return { slug, oldUrl, url: state.url, prefix, replaced };
  } finally {
    closeSync(fd);
    await job(ctx, slug, ["/bin/rm", "-rf", "--", work]).catch(() => {});
  }
}

/** Removes WP-Cron and the state (app.delete removes the rest). */
export async function removeWordpress(ctx: Context, slug: string): Promise<void> {
  const name = wpCronUnitName(slug);
  await ctx.exec(BIN.systemctl, ["disable", "--now", `${name}.timer`], { allowFail: true });
  for (const f of [`${name}.service`, `${name}.timer`]) {
    const file = join(ctx.paths.systemdDir, f);
    if (existsSync(file)) removeManaged(file);
  }
  removeManaged(stateFile(ctx, slug));
}

export const wordpressActions: ActionTable = {
  "wordpress.fetch": { mutates: true, run: wordpressFetch },
  "wordpress.install": { mutates: true, run: wordpressInstall },
  // The mail password and API key stay out of the audit log.
  "wordpress.config": { mutates: true, run: wordpressConfig, redact: (p) => ({ ...p, mail: p.mail && typeof p.mail === "object" ? { kind: (p.mail as { kind?: unknown }).kind } : p.mail }) },
  "wordpress.status": { mutates: false, run: wordpressStatus },
  "wordpress.run": { mutates: true, run: wordpressRun },
  "wordpress.import": { mutates: true, run: wordpressImport },
};

