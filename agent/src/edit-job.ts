// The database editor's job: `node -e EDIT_JOB <request JSON>`, run by
// db.count and db.update (actions/edit.ts) as the app's own user in the
// app's sandbox, with the app's own logins, like the viewer's job. It edits
// one SQL table (SQLite, Postgres or MySQL), never a view.
//
// The request names the rows by their primary keys (the rows picked in the
// grid, the rowid for a SQLite table without a primary key), by the visual
// builder's filters, or all of them. mode "count" only counts them, read
// only, for the confirmation; "apply" sets the given columns to the given
// values in one transaction, and only if exactly `expect` rows match, the
// number the user confirmed: if the table changed in between, nothing is
// written. Columns are quoted identifiers and values parameters or escaped
// literals (sql-where.ts).
//
// It prints one line, `LAYER-EDIT {matches}` or `LAYER-EDIT {updated}`, or
// `layer: <why>` on stderr and exits non-zero.
import { WHERE_LIB } from "./sql-where.ts";

export const EDIT_JOB = WHERE_LIB + String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const req = JSON.parse(process.argv[1]);

function fail(message) {
  console.error("layer: " + (String(message).trim().split("\n").filter(Boolean).pop() || "the editor failed"));
  process.exit(2);
}
const lastLine = (s) => String(s || "").trim().split("\n").filter(Boolean).pop() || "";
function finish(out) {
  process.stdout.write("LAYER-EDIT " + JSON.stringify(out) + "\n");
}
const mismatch = (n) =>
  n + " row" + (n === 1 ? "" : "s") + " match now, " + req.expect + " when you checked. Nothing was changed: look again and retry.";
/** The job's own "layer-mismatch N" error, from any engine, as the sentence above. */
function explain(message) {
  const m = /layer-mismatch (\d+)/.exec(String(message));
  return m ? mismatch(Number(m[1])) : message;
}

/** SET a = …, b = … for req.set, after checking each column exists. */
function setSql(columns, d) {
  return req.set
    .map((s) => {
      if (!columns.includes(s.column)) fail("there's no column " + s.column);
      return d.q(s.column) + " = " + (s.value === null ? "NULL" : d.v(s.value));
    })
    .join(", ");
}

/** " WHERE …" for req.target: rows by their keys, the builder's filters, or "" for every row. */
function targetSql(columns, keyColumns, d, keyRef) {
  const t = req.target;
  if (t.keys) {
    if (!keyColumns.length) fail(req.table + " has no primary key: pick rows with filters instead");
    if (JSON.stringify(t.keys.columns) !== JSON.stringify(keyColumns)) fail(req.table + "'s primary key changed: reload and try again");
    return " WHERE " + t.keys.rows.map((row) => "(" + keyColumns.map((k, i) => (row[i] === null ? keyRef(k) + " IS NULL" : keyRef(k) + " = " + d.v(row[i]))).join(" AND ") + ")").join(" OR ");
  }
  if (t.where) return whereSql(t.where, columns, d);
  return "";
}

// ---------------------------------------------------------------- SQLite

const HEADER = Buffer.from("SQLite format 3\0");
function isSqlite(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const head = Buffer.alloc(16);
    return fs.readSync(fd, head, 0, 16, 0) === 16 && head.equals(HEADER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function editSqlite() {
  const root = fs.realpathSync(".");
  let real = "";
  try {
    real = fs.realpathSync(path.resolve(root, req.file));
  } catch {
    fail(req.file + " isn't in the data folder");
  }
  if (!real.startsWith(root + path.sep) || !isSqlite(real)) fail(req.file + " isn't a SQLite database in the data folder");
  const { DatabaseSync } = require("node:sqlite");
  const counting = req.mode === "count";
  const db = new DatabaseSync(real, { readOnly: counting, timeout: 5000 });
  if (counting) db.exec("PRAGMA query_only = ON");
  const q = (s) => '"' + s.replaceAll('"', '""') + '"';
  const t = db.prepare("SELECT name, type FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view')").get(req.table);
  if (!t) fail("there's no table " + req.table);
  if (t.type !== "table") fail(req.table + " is a view: views can't be edited");
  const info = db.prepare("SELECT name, pk FROM pragma_table_info(?)").all(req.table);
  const columns = info.map((c) => c.name);
  const pk = info.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name);
  const keyColumns = pk.length ? pk : ["rowid"];
  const keyRef = (k) => (k === "rowid" && !pk.length ? "rowid" : q(k));
  const condParams = [];
  if (counting) {
    const cond = targetSql(columns, keyColumns, sqliteDialect(condParams), keyRef);
    return finish({ matches: Number(db.prepare("SELECT COUNT(*) AS n FROM " + q(req.table) + cond).get(...condParams).n) });
  }
  const setParams = [];
  const set = setSql(columns, sqliteDialect(setParams));
  const cond = targetSql(columns, keyColumns, sqliteDialect(condParams), keyRef);
  // IMMEDIATE takes the write lock first, so nothing changes between the count and the update.
  db.exec("BEGIN IMMEDIATE");
  try {
    const n = Number(db.prepare("SELECT COUNT(*) AS n FROM " + q(req.table) + cond).get(...condParams).n);
    if (n !== req.expect) throw new Error("layer-mismatch " + n);
    const changed = Number(db.prepare("UPDATE " + q(req.table) + " SET " + set + cond).run(...setParams, ...condParams).changes);
    if (changed !== req.expect) throw new Error("layer-mismatch " + changed);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    fail(explain(e.message));
  }
  finish({ updated: req.expect });
}

// ---------------------------------------------------------------- Postgres

function editPostgres() {
  const url = process.env.DATABASE_URL || "";
  if (!url.startsWith("postgresql://")) fail("this app has no Postgres");
  const login = new URL(url);
  const password = decodeURIComponent(login.password);
  login.password = "";
  const counting = req.mode === "count";
  const psql = (sql) => {
    const r = spawnSync("/usr/bin/psql", ["--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--command=" + sql, login.href], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60000,
      // Counting stays read-only; an update gets 30 s.
      env: { ...process.env, PGPASSWORD: password, PGOPTIONS: counting ? "-c default_transaction_read_only=on -c statement_timeout=5000" : "-c statement_timeout=30000", PGCONNECT_TIMEOUT: "5", PGAPPNAME: "layer-editor" },
    });
    if (r.status !== 0) fail(explain((String(r.stderr).split("\n").find((l) => l.includes("ERROR:")) || lastLine(r.stderr)).replace(/^.*?ERROR:\s*/, "") || "psql failed"));
    return r.stdout.trim();
  };
  const d = postgresDialect();
  const list = JSON.parse(
    psql(
      "SELECT coalesce(json_agg(json_build_object('name', CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END, " +
        "'ref', quote_ident(n.nspname) || '.' || quote_ident(c.relname), 'kind', c.relkind)), '[]') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE c.relkind IN ('r', 'v', 'm', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'",
    ) || "[]",
  );
  const t = list.find((x) => x.name === req.table);
  if (!t) fail("there's no table " + req.table);
  if (t.kind !== "r" && t.kind !== "p") fail(req.table + " is a view: views can't be edited");
  const info = JSON.parse(
    psql(
      "SELECT coalesce(json_agg(json_build_object('name', a.attname, 'pk', coalesce(a.attnum = ANY(i.indkey), false)) ORDER BY a.attnum), '[]') FROM pg_attribute a " +
        "LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary WHERE a.attrelid = " + d.lit(t.ref) + "::regclass AND a.attnum > 0 AND NOT a.attisdropped",
    ),
  );
  const columns = info.map((c) => c.name);
  const keyColumns = info.filter((c) => c.pk).map((c) => c.name);
  const cond = targetSql(columns, keyColumns, d, d.q);
  if (counting) return finish({ matches: Number(psql("SELECT count(*) FROM " + t.ref + cond)) });
  const set = setSql(columns, d);
  // One DO block is one transaction: if the update touches anything but the
  // confirmed number of rows, the exception rolls all of it back.
  const tag = "$layer" + crypto.randomBytes(6).toString("hex") + "$";
  const body =
    "DECLARE n bigint; BEGIN UPDATE " + t.ref + " SET " + set + cond + "; GET DIAGNOSTICS n = ROW_COUNT; " +
    "IF n <> " + Number(req.expect) + " THEN RAISE EXCEPTION 'layer-mismatch %', n; END IF; END";
  if (body.includes(tag)) fail("a value contains the block's quote: try again");
  psql("DO " + tag + " " + body + " " + tag);
  finish({ updated: req.expect });
}

// ---------------------------------------------------------------- MySQL (MariaDB)

function editMysql() {
  const raw = process.env.DATABASE_URL || "";
  if (!raw.startsWith("mysql://")) fail("this app has no MySQL");
  const u = new URL(raw);
  const counting = req.mode === "count";
  // Statements go in on stdin (batch mode), so the update can be a compound block with its own delimiter.
  const mariadb = (script) => {
    const r = spawnSync(
      "/usr/bin/mariadb",
      ["--protocol=TCP", "--host=" + u.hostname, "--port=" + (u.port || "3306"), "--user=" + decodeURIComponent(u.username), "--connect-timeout=5", "--batch", "--skip-column-names", decodeURIComponent(u.pathname.slice(1))],
      { input: script, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000, env: { ...process.env, MYSQL_PWD: decodeURIComponent(u.password) } },
    );
    if (r.status !== 0) fail(explain(lastLine(r.stderr).replace(/^ERROR \d+ \([^)]*\)( at line \d+)?: /, "") || "mariadb failed"));
    return r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
  };
  const d = mysqlDialect();
  const [kind] = mariadb("SELECT table_type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = " + d.lit(req.table) + ";\n");
  if (!kind) fail("there's no table " + req.table);
  if (kind[0] !== "BASE TABLE") fail(req.table + " is a view: views can't be edited");
  const info = mariadb("SELECT column_name, column_key FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = " + d.lit(req.table) + " ORDER BY ordinal_position;\n");
  const columns = info.map((r) => r[0]);
  const keyColumns = info.filter((r) => r[1] === "PRI").map((r) => r[0]);
  const ref = d.q(req.table);
  const cond = targetSql(columns, keyColumns, d, d.q);
  if (counting) {
    const [[n]] = mariadb("SET SESSION TRANSACTION READ ONLY; SET SESSION max_statement_time = 5;\nSELECT COUNT(*) FROM " + ref + cond + ";\n");
    return finish({ matches: Number(n) });
  }
  const set = setSql(columns, d);
  // One transaction: lock and count the rows, give up unless it's the
  // confirmed number, then update. Any error rolls the whole block back.
  mariadb(
    "SET SESSION max_statement_time = 30;\nDELIMITER //\n" +
      "BEGIN NOT ATOMIC\n" +
      "  DECLARE n BIGINT DEFAULT 0;\n" +
      "  DECLARE msg VARCHAR(64);\n" +
      "  DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;\n" +
      "  START TRANSACTION;\n" +
      "  SELECT COUNT(*) INTO n FROM " + ref + cond + " FOR UPDATE;\n" +
      "  IF n <> " + Number(req.expect) + " THEN SET msg = CONCAT('layer-mismatch ', n); SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg; END IF;\n" +
      "  UPDATE " + ref + " SET " + set + cond + ";\n" +
      "  COMMIT;\n" +
      "END//\nDELIMITER ;\n",
  );
  finish({ updated: req.expect });
}

try {
  if (req.engine === "sqlite") editSqlite();
  else if (req.engine === "postgres") editPostgres();
  else if (req.engine === "mysql") editMysql();
  else fail("the editor can't change " + req.engine);
} catch (e) {
  fail(explain(e.message));
}
`;
