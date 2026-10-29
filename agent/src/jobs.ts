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
 * Postgres), a pg_dump made with the app's own role goes in as
 * .layer-postgres.dump. The last stderr line is
 * `LAYER-SNAPSHOT {"sqlite":[{path,bytes}],"postgres":{bytes}|null}`.
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

  // The app's Postgres database, dumped with its own credentials. It travels
  // in the archive as .layer-postgres.dump; restore loads it back.
  let postgres = null;
  if (process.env.DATABASE_URL) {
    const dump = path.join(snap, ".layer-postgres.dump");
    const r = spawnSync("/usr/bin/pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file=" + dump, process.env.DATABASE_URL], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (r.status !== 0) {
      console.error("layer: pg_dump failed: " + String(r.stderr || r.error).trim().split("\n").pop());
      process.exit(5);
    }
    postgres = { bytes: fs.statSync(dump).size };
  }

  const excludes = path.join(stage, "excludes");
  const skip = databases.flatMap((rel) => ["", "-wal", "-shm", "-journal"].map((s) => "./" + rel + s));
  skip.push("./.layer-postgres.dump");
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
    console.error("LAYER-SNAPSHOT " + JSON.stringify({ sqlite: report, postgres }));
  });
})().catch((err) => {
  console.error("layer: snapshot failed: " + (err && err.message ? err.message : err));
  process.exit(2);
});
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
  '  if [ -z "${DATABASE_URL:-}" ]; then echo "layer: the backup has a Postgres dump, but the app has no Postgres now; skipped it"; rm -f -- "$dump";',
  '  elif ! pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction --dbname="$DATABASE_URL" "$dump"; then rm -f -- "$dump"; echo "layer: files restored, but loading the Postgres dump failed"; exit 2;',
  '  else rm -f -- "$dump"; echo "layer: Postgres database restored"; fi',
  'fi',
  // Keep only the folder this restore replaced.
  'for old in "$app"/data.before-restore-*; do [ "$old" = "$app/data.before-restore-$stamp" ] || rm -rf -- "$old"; done',
].join("\n");
