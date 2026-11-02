// Scripts the agent runs as an app user inside the app's sandbox (via
// systemd-run). They are passed as arguments, so nothing extra has to be
// installed where the app user can read it.

/**
 * Backup snapshot: `node -e SNAPSHOT_JOB <dataDir>`. Writes a tar.gz of the
 * data folder to stdout. Every SQLite file (found by its header, not its
 * name) is copied with SQLite's online backup API, which is safe while the
 * app writes (WAL included), and the copy must pass PRAGMA integrity_check.
 * The archive holds those checked copies in place of the live files and
 * leaves out -wal/-shm/-journal. With DATABASE_URL set (the app has
 * Postgres or MySQL), a dump made with the app's own login goes in as
 * .layer-postgres.dump or .layer-mysql.sql; with MONGODB_URI, a mongodump as
 * .layer-mongodb.archive. The last stderr line is
 * `LAYER-SNAPSHOT {"sqlite":[{path,bytes}],"postgres":{bytes}|null,"mysql":{bytes}|null,"mongodb":{bytes}|null}`.
 */
export const SNAPSHOT_JOB = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync, backup } = require("node:sqlite");

const data = process.argv[1];
const HEADER = Buffer.from("SQLite format 3\0");

function isSqlite(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const head = Buffer.alloc(16);
    return fs.readSync(fd, head, 0, 16, 0) === 16 && head.equals(HEADER);
  } finally {
    fs.closeSync(fd);
  }
}

function findDatabases(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.includes("\n")) continue;
    const name = rel ? rel + "/" + entry.name : entry.name;
    if (entry.isDirectory()) findDatabases(path.join(dir, entry.name), name, out);
    else if (entry.isFile() && isSqlite(path.join(dir, entry.name))) out.push(name);
  }
  return out;
}

(async () => {
  const stage = fs.mkdtempSync("/tmp/layer-snapshot-");
  const snap = path.join(stage, ".layer-snapshot");
  fs.mkdirSync(snap);
  const databases = findDatabases(data, "", []);
  const report = [];
  for (const rel of databases) {
    const dest = path.join(snap, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const source = new DatabaseSync(path.join(data, rel), { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest);
    let result;
    try {
      copy.exec("PRAGMA journal_mode=DELETE");
      result = copy.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]).join("; ");
    } finally {
      copy.close();
    }
    if (result !== "ok") {
      console.error("layer: " + rel + " failed SQLite's integrity check: " + result.slice(0, 300));
      process.exit(3);
    }
    report.push({ path: rel, bytes: fs.statSync(dest).size });
  }

  // The app's SQL database, dumped with its own login. It travels in the
  // archive as .layer-postgres.dump or .layer-mysql.sql; restore loads it back.
  let postgres = null;
  let mysql = null;
  const url = process.env.DATABASE_URL || "";
  if (url.startsWith("postgresql://")) {
    const dump = path.join(snap, ".layer-postgres.dump");
    // The password in the environment, as for MySQL below; the URL without it.
    const u = new URL(url);
    const password = decodeURIComponent(u.password);
    u.password = "";
    const r = spawnSync("/usr/bin/pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file=" + dump, u.href], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", env: { ...process.env, PGPASSWORD: password } });
    if (r.status !== 0) {
      console.error("layer: pg_dump failed: " + String(r.stderr || r.error).trim().split("\n").pop());
      process.exit(5);
    }
    postgres = { bytes: fs.statSync(dump).size };
  } else if (url.startsWith("mysql://")) {
    const u = new URL(url);
    const dump = path.join(snap, ".layer-mysql.sql");
    const r = spawnSync(
      "/usr/bin/mariadb-dump",
      ["--single-transaction", "--quick", "--routines", "--events", "--protocol=TCP", "--host=" + u.hostname, "--port=" + (u.port || "3306"), "--user=" + decodeURIComponent(u.username), "--result-file=" + dump, decodeURIComponent(u.pathname.slice(1))],
      // The password in the environment: other users can't read it there, unlike in arguments.
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", env: { ...process.env, MYSQL_PWD: decodeURIComponent(u.password) } },
    );
    if (r.status !== 0) {
      console.error("layer: mariadb-dump failed: " + String(r.stderr || r.error).trim().split("\n").pop());
      process.exit(5);
    }
    mysql = { bytes: fs.statSync(dump).size };
  }

  // The app's MongoDB, the same way, as .layer-mongodb.archive. Its login goes
  // to mongodump in a file only this job can read, not in the arguments.
  let mongodb = null;
  const mongoUrl = process.env.MONGODB_URI || "";
  if (mongoUrl.startsWith("mongodb://")) {
    const dump = path.join(snap, ".layer-mongodb.archive");
    const login = path.join(stage, "mongodb-login.yaml");
    fs.writeFileSync(login, "uri: " + JSON.stringify(mongoUrl) + "\n", { mode: 0o600 });
    const r = spawnSync("/usr/bin/mongodump", ["--config=" + login, "--archive=" + dump, "--gzip", "--quiet"], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    fs.rmSync(login, { force: true });
    if (r.status !== 0) {
      console.error("layer: mongodump failed: " + String(r.stderr || r.error).trim().split("\n").pop());
      process.exit(5);
    }
    mongodb = { bytes: fs.statSync(dump).size };
  }

  const excludes = path.join(stage, "excludes");
  const skip = databases.flatMap((rel) => ["", "-wal", "-shm", "-journal"].map((s) => "./" + rel + s));
  skip.push("./.layer-postgres.dump", "./.layer-mysql.sql", "./.layer-mongodb.archive");
  fs.writeFileSync(excludes, skip.join("\n") + "\n");
  const tar = spawn(
    "/usr/bin/tar",
    [
      "--create", "--gzip", "--file=-",
      "--anchored", "--no-wildcards", "--exclude-from=" + excludes,
      "--warning=no-file-changed", "--warning=no-file-removed",
      "-C", data, ".",
      // The checked copies, renamed back to where the live files were.
      "--transform=s,^\\.layer-snapshot,.,",
      "-C", stage, ".layer-snapshot",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  tar.on("close", (code) => {
    // 1: a file changed while it was read (an upload in progress). Still a usable backup.
    if (code !== 0 && code !== 1) {
      console.error("layer: tar exited " + code);
      process.exit(4);
    }
    console.error("LAYER-SNAPSHOT " + JSON.stringify({ sqlite: report, postgres, mysql, mongodb }));
  });
})().catch((err) => {
  console.error("layer: snapshot failed: " + (err && err.message ? err.message : err));
  process.exit(2);
});
`;

/**
 * Import: `node -e IMPORT_JOB <appDir> <stamp> <gzip|plain> <name>` with, on
 * stdin, either an archive of a data folder from somewhere else (another
 * server, made by hand: tar, or tar.gz) or a single SQLite database (raw or
 * gzipped). What it is comes from its first bytes after gunzip, here, as the
 * app: root never decompresses it.
 *
 * An archive unpacks into data.importing-<stamp> and drops macOS litter (._*,
 * .DS_Store, __MACOSX). An archive holding a single folder counts as that
 * folder. A database goes in as data.importing-<stamp>/<target>: the file in
 * data/ named like the upload, else data/'s only database, else the upload's
 * name (data.db with none); the agent then replaces just that file. Every
 * SQLite file (found by its header) must open, replay its WAL and pass
 * PRAGMA integrity_check; stale -shm files go. The agent swaps the result in
 * with the app stopped, or deletes it when this fails. The last stderr line
 * is `LAYER-IMPORT {"root","sqlite":[{path,bytes}],"files","bytes","database"?}`.
 */
export const IMPORT_JOB = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { Readable, pipeline } = require("node:stream");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const [app, stamp, format, wanted] = process.argv.slice(1);
const work = path.join(app, "data.importing-" + stamp);
const HEADER = Buffer.from("SQLite format 3\0");
const LITTER = (name) => name === "__MACOSX" || name === ".DS_Store" || name.startsWith("._");
const SIDECAR = /-(shm|wal|journal)$/;

function fail(code, message) {
  console.error("layer: " + message);
  process.exit(code);
}

function isSqlite(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const head = Buffer.alloc(16);
    return fs.readSync(fd, head, 0, 16, 0) === 16 && head.equals(HEADER);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Every regular file under dir (relative paths). Litter is deleted on the way;
 * with own, modes become the app's alone (files rw, folders rwx), whatever
 * they were on the old server.
 */
function files(dir, own = false, rel = "", out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (LITTER(entry.name)) {
      fs.rmSync(full, { recursive: true, force: true });
      continue;
    }
    const name = rel ? rel + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (own) fs.chmodSync(full, 0o700);
      files(full, own, name, out);
    } else if (entry.isFile()) {
      if (own) fs.chmodSync(full, (fs.statSync(full).mode & 0o700) | 0o600);
      out.push(name);
    }
  }
  return out;
}

/** Which file in data/ a single database replaces. */
function targetFor(name) {
  const data = path.join(app, "data");
  let entries = [];
  try {
    entries = fs.readdirSync(data, { withFileTypes: true });
  } catch {}
  if (entries.some((e) => e.name === name)) return name;
  const dbs = entries.filter((e) => e.isFile() && !SIDECAR.test(e.name) && isSqlite(path.join(data, e.name)));
  return dbs.length === 1 ? dbs[0].name : name;
}

async function receive() {
  const input = format === "gzip" ? process.stdin.pipe(zlib.createGunzip()) : process.stdin;
  const chunks = input[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  for (let next; head.length < 512 && !(next = await chunks.next()).done; ) head = Buffer.concat([head, next.value]);
  // A cut-off or damaged gzip ends the stream early: tar alone might take what came.
  let broken = null;
  const rest = Readable.from((async function* () {
    yield head;
    try {
      for (let next; !(next = await chunks.next()).done; ) yield next.value;
    } catch (err) {
      broken = err;
      throw err;
    }
  })());

  if (head.length >= 262 && head.toString("latin1", 257, 262) === "ustar") {
    const tar = spawn("/usr/bin/tar", ["--extract", "--file=-", "--no-same-owner", "--no-same-permissions", "--directory=" + work], { stdio: ["pipe", "inherit", "pipe"] });
    let said = "";
    tar.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      said += chunk;
    });
    // tar may stop reading early on a broken archive; its exit code says so.
    pipeline(rest, tar.stdin, () => {});
    const code = await new Promise((done) => tar.on("close", done));
    if (broken) fail(4, "the archive is cut off or damaged (" + (broken.message || broken) + "); data/ is unchanged");
    if (code !== 0) {
      // tar's own reason, not its closing lines or warnings about macOS headers.
      const why = said
        .split("\n")
        .map((l) => /^(?:\/usr\/bin\/)?tar: (.+)$/.exec(l)?.[1])
        .filter((l) => l && !/^(Exiting with failure|Error is not recoverable|Ignoring unknown extended header)/.test(l))
        .at(-1);
      fail(4, "the archive could not be unpacked (" + (why || "tar exited " + code) + "); data/ is unchanged");
    }
    return null;
  }
  if (head.length >= 16 && head.subarray(0, 16).equals(HEADER)) {
    const name = targetFor(wanted || "data.db");
    await new Promise((done, failed) => pipeline(rest, fs.createWriteStream(path.join(work, name), { flags: "wx", mode: 0o600 }), (err) => (err ? failed(err) : done())));
    console.log("A single SQLite database: it replaces data/" + name + ", and the rest of data/ stays.");
    return name;
  }
  fail(4, "this isn't a .tar.gz or .tar of a data folder, or a SQLite database" + (format === "gzip" ? " (it's gzip, but what's inside is neither)" : "") + "; data/ is unchanged");
}

try {
  fs.mkdirSync(work, { mode: 0o700 });
} catch (err) {
  fail(2, "can't make " + work + ": " + err.message);
}
receive().then((database) => {
  try {
    files(work, true);
    const top = fs.readdirSync(work, { withFileTypes: true });
    const root = top.length === 1 && top[0].isDirectory() ? top[0].name : "";
    const base = root ? path.join(work, root) : work;
    for (const [dump, engine] of [[".layer-postgres.dump", "Postgres"], [".layer-mysql.sql", "MySQL"], [".layer-mongodb.archive", "MongoDB"]]) {
      if (!fs.existsSync(path.join(base, dump))) continue;
      fs.rmSync(path.join(base, dump));
      console.log("Skipped " + dump + ": " + engine + " data comes back through a backup restore.");
    }

    const sqlite = [];
    for (const rel of files(base).filter((f) => !/-(shm|wal|journal)$/.test(f))) {
      const file = path.join(base, rel);
      if (!isSqlite(file)) continue;
      // A -shm from another machine is only an index; SQLite rebuilds it from the -wal.
      fs.rmSync(file + "-shm", { force: true });
      let result;
      try {
        const db = new DatabaseSync(file);
        try {
          result = db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]).join("; ");
          if (result === "ok") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          db.close();
        }
      } catch (err) {
        result = err && err.message ? err.message : String(err);
      }
      if (result !== "ok") fail(3, rel + " failed SQLite's integrity check (" + String(result).slice(0, 300) + "); data/ is unchanged");
      sqlite.push({ path: rel, bytes: fs.statSync(file).size });
      console.log("Checked " + rel + ": ok");
    }

    const all = files(base);
    if (all.length === 0) fail(5, "the archive has no files; data/ is unchanged");
    const bytes = all.reduce((n, f) => n + fs.statSync(path.join(base, f)).size, 0);
    console.error("LAYER-IMPORT " + JSON.stringify({ root, sqlite, files: all.length, bytes, ...(database ? { database } : {}) }));
  } catch (err) {
    fail(2, "import failed: " + (err && err.message ? err.message : err));
  }
}, (err) => fail(4, "the file could not be read (" + (err && err.message ? err.message : err) + "); data/ is unchanged"));
`;

/**
 * Restore: `sh -c RESTORE_JOB layer-restore <appDir> <stamp>` with the tar.gz
 * on stdin. Unpacks next to data/ first, so a broken archive changes nothing;
 * then swaps folders and keeps the old one as data.before-restore-<stamp>
 * (only the latest; older ones are removed).
 */
export const RESTORE_JOB = [
  'app="$1"; stamp="$2"; new="$app/data.restoring-$stamp"',
  'rm -rf -- "$new"',
  'mkdir -m 700 -- "$new"',
  'if ! tar --extract --gzip --file=- --no-same-owner --directory="$new"; then rm -rf -- "$new"; echo "layer: the backup could not be unpacked; data/ is unchanged"; exit 1; fi',
  'chmod 700 -- "$new"',
  'if [ -e "$app/data" ]; then mv -- "$app/data" "$app/data.before-restore-$stamp"; fi',
  'mv -- "$new" "$app/data"',
  // The app's Postgres, from the dump inside the backup (with the app's own role).
  'dump="$app/data/.layer-postgres.dump"',
  'if [ -f "$dump" ]; then',
  '  case "${DATABASE_URL:-}" in',
  '    postgresql://*)',
  // The password in the environment (the agent's URL: a hex password), not in pg_restore's arguments.
  '      rest="${DATABASE_URL#postgresql://}"; login="${rest%%@*}"; PGPASSWORD="${login#*:}"; export PGPASSWORD',
  '      if ! pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction --dbname="postgresql://${login%%:*}@${rest#*@}" "$dump"; then rm -f -- "$dump"; echo "layer: files restored, but loading the Postgres dump failed"; exit 2; fi',
  '      rm -f -- "$dump"; echo "layer: Postgres database restored" ;;',
  '    *) rm -f -- "$dump"; echo "layer: the backup has a Postgres dump, but the app has no Postgres now; skipped it" ;;',
  '  esac',
  'fi',
  // The app's MySQL, the same way. MySQL can't load a dump in one transaction,
  // so the database as it was is dumped next to the replaced files first.
  'dump="$app/data/.layer-mysql.sql"',
  'if [ -f "$dump" ]; then',
  '  case "${DATABASE_URL:-}" in',
  '    mysql://*)',
  '      rest="${DATABASE_URL#mysql://}"; login="${rest%%@*}"; MYSQL_PWD="${login#*:}"; export MYSQL_PWD',
  '      set -- --protocol=TCP --host=127.0.0.1 --port=3306 --user="${login%%:*}"',
  '      before="$app/data.before-restore-$stamp"; mkdir -p -m 700 -- "$before"',
  '      if ! mariadb-dump "$@" --single-transaction --quick --routines --events --result-file="$before/.layer-mysql.sql" "${rest##*/}"; then rm -f -- "$dump"; echo "layer: files restored, but the MySQL database could not be saved first, so it was left as it was"; exit 2; fi',
  '      if ! mariadb "$@" --batch "${rest##*/}" <"$dump"; then rm -f -- "$dump"; echo "layer: files restored, but loading the MySQL dump failed; the database as it was is in data.before-restore-$stamp/.layer-mysql.sql"; exit 2; fi',
  '      rm -f -- "$dump"; echo "layer: MySQL database restored" ;;',
  '    *) rm -f -- "$dump"; echo "layer: the backup has a MySQL dump, but the app has no MySQL now; skipped it" ;;',
  '  esac',
  'fi',
  // The app's MongoDB, like MySQL: the database as it was is dumped next to the
  // replaced files, then the backup's dump replaces its collections. The login
  // goes to the tools in a file (authSource: the app's database, where its user
  // lives), not in their arguments.
  'dump="$app/data/.layer-mongodb.archive"',
  'if [ -f "$dump" ]; then',
  '  case "${MONGODB_URI:-}" in',
  '    mongodb://*)',
  '      db="${MONGODB_URI##*/}"; login="$(mktemp)"; echo "uri: \\"${MONGODB_URI%/*}/?authSource=$db\\"" >"$login"',
  '      before="$app/data.before-restore-$stamp"; mkdir -p -m 700 -- "$before"',
  '      if ! mongodump --config="$login" --db="$db" --archive="$before/.layer-mongodb.archive" --gzip --quiet; then rm -f -- "$dump" "$login"; echo "layer: files restored, but the MongoDB database could not be saved first, so it was left as it was"; exit 2; fi',
  '      if ! mongorestore --config="$login" --nsInclude="$db.*" --archive="$dump" --gzip --drop --quiet; then rm -f -- "$dump" "$login"; echo "layer: files restored, but loading the MongoDB dump failed; the database as it was is in data.before-restore-$stamp/.layer-mongodb.archive"; exit 2; fi',
  '      rm -f -- "$dump" "$login"; echo "layer: MongoDB database restored" ;;',
  '    *) rm -f -- "$dump"; echo "layer: the backup has a MongoDB dump, but the app has no MongoDB now; skipped it" ;;',
  '  esac',
  'fi',
  // Keep only the folder this restore replaced.
  'for old in "$app"/data.before-restore-*; do [ "$old" = "$app/data.before-restore-$stamp" ] || rm -rf -- "$old"; done',
].join("\n");
