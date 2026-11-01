// The database viewer's job: `node -e BROWSE_JOB <request JSON>`, run by
// db.browse as the app's own user in the app's sandbox, with the app's own
// logins (services.env), like the backup jobs in jobs.ts. It lists what's in
// one database (tables, collections or keys) and, when asked, a page of rows
// or the result of a read-only query. Every engine is opened read-only:
// SQLite read-only with query_only on, Postgres with every transaction read
// only, MariaDB in a read-only session, MongoDB with find alone, Redis with
// read commands alone. Values longer than 2000 characters are cut, and rows
// stop at 4 MB of output.
//
// It prints one line, `LAYER-BROWSE {tables, files?, more?, result?}`, or
// `layer: <why>` on stderr and exits non-zero.

export const BROWSE_JOB = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawnSync } = require("node:child_process");

const req = JSON.parse(process.argv[1]);
const MAX_TEXT = 2000;
const BUDGET = 4 * 1024 * 1024;
const QUERY_ROWS = 500;
let used = 0;

function fail(message) {
  console.error("layer: " + (String(message).trim().split("\n").filter(Boolean).pop() || "the viewer failed"));
  process.exit(2);
}
const lastLine = (s) => String(s || "").trim().split("\n").filter(Boolean).pop() || "";
function finish(out) {
  process.stdout.write("LAYER-BROWSE " + JSON.stringify(out) + "\n");
}

/** A value as the panel shows it: long text cut (with its length), bytes as a size. */
function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  if (v instanceof Uint8Array) return { bytes: v.length };
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > MAX_TEXT ? { text: s.slice(0, MAX_TEXT), length: s.length } : s;
}

/** Rows until the output budget is spent; truncated says some were left out. */
function take(rows) {
  const out = [];
  for (const row of rows) {
    used += JSON.stringify(row).length;
    if (used > BUDGET) return { rows: out, truncated: true };
    out.push(row);
  }
  return { rows: out, truncated: false };
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

/** How many tables a SQLite database has, or null if it can't be read. */
function tableCount(file) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
    try {
      db.exec("PRAGMA query_only = ON");
      return Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** SQLite databases in the data folder, found by their header, not their name. */
function sqliteFiles(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= 100) break;
    const name = rel ? rel + "/" + e.name : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && rel.split("/").length < 6) sqliteFiles(full, name, out);
    else if (e.isFile() && !/-(wal|shm|journal)$/.test(e.name) && isSqlite(full)) out.push({ path: name, bytes: fs.statSync(full).size, tables: tableCount(full) });
  }
  return out;
}

function browseSqlite() {
  const root = fs.realpathSync(".");
  if (!req.file) return finish({ files: sqliteFiles(root, "", []), tables: [] });
  let real = "";
  try {
    real = fs.realpathSync(path.resolve(root, req.file));
  } catch {
    fail(req.file + " isn't in the data folder");
  }
  if (!real.startsWith(root + path.sep) || !isSqlite(real)) fail(req.file + " isn't a SQLite database in the data folder");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(real, { readOnly: true, timeout: 5000 });
  db.exec("PRAGMA query_only = ON");
  const q = (s) => '"' + s.replaceAll('"', '""') + '"';
  const count = (name) => Number(db.prepare("SELECT COUNT(*) AS n FROM " + q(name)).get().n);
  const tables = db
    .prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((t) => ({ name: t.name, type: t.type, rows: null }));
  // Counting scans a table: a second and a half for all of them, the rest stay unknown.
  const started = Date.now();
  for (const t of tables) if (t.type === "table" && Date.now() - started < 1500) t.rows = count(t.name);
  const out = { tables };
  if (req.op === "rows") {
    const t = tables.find((x) => x.name === req.table);
    if (!t) fail("there's no table " + req.table);
    const columns = db.prepare("SELECT name FROM pragma_table_info(?)").all(t.name).map((c) => c.name);
    if (req.sort && !columns.includes(req.sort)) fail("there's no column " + req.sort);
    const begun = Date.now();
    const stmt = db.prepare("SELECT * FROM " + q(t.name) + (req.sort ? " ORDER BY " + q(req.sort) + (req.desc ? " DESC" : "") : "") + " LIMIT ? OFFSET ?");
    stmt.setReturnArrays(true);
    const taken = take(stmt.all(req.limit, req.offset).map((r) => r.map(cell)));
    out.result = { columns: stmt.columns().map((c) => c.name), rows: taken.rows, truncated: taken.truncated, total: t.rows ?? count(t.name), ms: Date.now() - begun };
  }
  if (req.op === "query") {
    const begun = Date.now();
    let stmt;
    const rows = [];
    let more = false;
    try {
      stmt = db.prepare(req.query);
      stmt.setReturnArrays(true);
      for (const r of stmt.iterate()) {
        if (rows.length === QUERY_ROWS) {
          more = true;
          break;
        }
        rows.push(r.map(cell));
      }
    } catch (e) {
      fail(e.message);
    }
    const taken = take(rows);
    out.result = { columns: stmt.columns().map((c) => c.name), rows: taken.rows, truncated: taken.truncated || more, total: null, ms: Date.now() - begun };
  }
  finish(out);
}

// ---------------------------------------------------------------- Postgres

function browsePostgres() {
  const url = process.env.DATABASE_URL || "";
  if (!url.startsWith("postgresql://")) fail("this app has no Postgres");
  // The password in the environment, not in psql's arguments (other users could see those).
  const login = new URL(url);
  const password = decodeURIComponent(login.password);
  login.password = "";
  const psql = (sql) => {
    const r = spawnSync("/usr/bin/psql", ["--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--command=" + sql, login.href], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20000,
      // Every transaction read-only, and no statement longer than 5 s.
      env: { ...process.env, PGPASSWORD: password, PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=5000", PGCONNECT_TIMEOUT: "5", PGAPPNAME: "layer-viewer" },
    });
    // psql's error comes with LINE and caret lines after it: the ERROR line says why.
    if (r.status !== 0) fail((String(r.stderr).split("\n").find((l) => l.includes("ERROR:")) || lastLine(r.stderr)).replace(/^.*?ERROR:\s*/, "") || "psql failed");
    return JSON.parse(r.stdout.trim() || "null");
  };
  const lit = (s) => "'" + s.replaceAll("'", "''") + "'";
  const qi = (s) => '"' + s.replaceAll('"', '""') + '"';
  const list = psql(
    "SELECT coalesce(json_agg(t ORDER BY t.schema <> 'public', t.schema, t.name), '[]') FROM (" +
      "SELECT n.nspname AS schema, c.relname AS name, CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS type, " +
      "CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows " +
      "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE c.relkind IN ('r', 'v', 'm', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' " +
      "AND has_table_privilege(c.oid, 'SELECT')) t",
  );
  const tables = list.map((t) => ({ name: t.schema === "public" ? t.name : t.schema + "." + t.name, type: t.type, rows: t.rows, ref: qi(t.schema) + "." + qi(t.name) }));
  const out = { tables: tables.map((t) => ({ name: t.name, type: t.type, rows: t.rows })) };
  if (req.op === "rows") {
    const t = tables.find((x) => x.name === req.table);
    if (!t) fail("there's no table " + req.table);
    const columns = psql("SELECT coalesce(json_agg(attname ORDER BY attnum), '[]') FROM pg_attribute WHERE attrelid = " + lit(t.ref) + "::regclass AND attnum > 0 AND NOT attisdropped");
    if (req.sort && !columns.includes(req.sort)) fail("there's no column " + req.sort);
    const begun = Date.now();
    const page = psql(
      "SELECT json_build_object('rows', (SELECT coalesce(json_agg(to_json(p)), '[]') FROM (SELECT * FROM " + t.ref +
        (req.sort ? " ORDER BY " + qi(req.sort) + (req.desc ? " DESC" : "") : "") +
        " LIMIT " + req.limit + " OFFSET " + req.offset + ") p), 'total', (SELECT count(*) FROM " + t.ref + "))",
    );
    const taken = take(page.rows.map((r) => columns.map((c) => cell(r[c]))));
    out.result = { columns, rows: taken.rows, truncated: taken.truncated, total: page.total, ms: Date.now() - begun };
  }
  if (req.op === "query") {
    const begun = Date.now();
    // A newline before the closing parenthesis, so a trailing -- comment can't swallow it.
    const rows = psql("SELECT coalesce(json_agg(to_json(q)), '[]') FROM (SELECT * FROM (" + req.query + "\n) q0 LIMIT " + (QUERY_ROWS + 1) + ") q");
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const taken = take(rows.slice(0, QUERY_ROWS).map((r) => columns.map((c) => cell(r[c]))));
    out.result = { columns, rows: taken.rows, truncated: taken.truncated || rows.length > QUERY_ROWS, total: null, ms: Date.now() - begun };
  }
  finish(out);
}

// ---------------------------------------------------------------- MySQL (MariaDB)

/**
 * mariadb --xml output: one array per result set (but those of SET
 * statements), of rows of [name, value or null]. XML says NULL apart from
 * the text "NULL", which tab-separated output can't.
 */
function parseXml(xml) {
  const named = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  const decode = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : named[e]));
  const sets = [];
  for (const set of xml.matchAll(/<resultset\b([^>]*?)(?:\/>|>([\s\S]*?)<\/resultset>)/g)) {
    if (/^\s*SET\s/i.test(decode(/statement="([^"]*)"/.exec(set[1])?.[1] || ""))) continue;
    const rows = [];
    for (const row of (set[2] || "").matchAll(/<row>([\s\S]*?)<\/row>/g)) {
      const fields = [];
      for (const f of row[1].matchAll(/<field name="([^"]*)"(\s+xsi:nil="true")?\s*(?:\/>|>([\s\S]*?)<\/field>)/g)) fields.push([decode(f[1]), f[2] ? null : decode(f[3] || "")]);
      rows.push(fields);
    }
    sets.push(rows);
  }
  return sets;
}

function browseMysql() {
  const raw = process.env.DATABASE_URL || "";
  if (!raw.startsWith("mysql://")) fail("this app has no MySQL");
  const u = new URL(raw);
  const mariadb = (sql) => {
    const r = spawnSync(
      "/usr/bin/mariadb",
      ["--protocol=TCP", "--host=" + u.hostname, "--port=" + (u.port || "3306"), "--user=" + decodeURIComponent(u.username), "--connect-timeout=5", "--xml",
        // A read-only session, and no statement longer than 5 s.
        "--execute=SET SESSION TRANSACTION READ ONLY; SET SESSION max_statement_time = 5; " + sql, decodeURIComponent(u.pathname.slice(1))],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20000, env: { ...process.env, MYSQL_PWD: decodeURIComponent(u.password) } },
    );
    if (r.status !== 0) fail(lastLine(r.stderr).replace(/^ERROR \d+ \([^)]*\)( at line \d+)?: /, "") || "mariadb failed");
    return parseXml(r.stdout);
  };
  const lit = (s) => "'" + s.replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";
  const qi = (s) => "\x60" + s.replaceAll("\x60", "\x60\x60") + "\x60";
  const [list] = mariadb("SELECT table_name AS name, table_type AS type, table_rows AS n FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name");
  const field = (row, name) => row.find((f) => f[0].toLowerCase() === name)?.[1] ?? null;
  const tables = (list || []).map((r) => ({ name: field(r, "name"), type: field(r, "type") === "VIEW" ? "view" : "table", rows: field(r, "n") === null ? null : Number(field(r, "n")) }));
  const out = { tables };
  if (req.op === "rows") {
    const t = tables.find((x) => x.name === req.table);
    if (!t) fail("there's no table " + req.table);
    const begun = Date.now();
    const [cols, counted, rows] = mariadb(
      "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = " + lit(t.name) + " ORDER BY ordinal_position; " +
        "SELECT COUNT(*) AS n FROM " + qi(t.name) + "; " +
        "SELECT * FROM " + qi(t.name) + (req.sort ? " ORDER BY " + qi(req.sort) + (req.desc ? " DESC" : "") : "") + " LIMIT " + req.limit + " OFFSET " + req.offset,
    );
    const columns = (cols || []).map((r) => r[0][1]);
    const taken = take((rows || []).map((r) => columns.map((c) => cell(r.find((f) => f[0] === c)?.[1] ?? null))));
    out.result = { columns, rows: taken.rows, truncated: taken.truncated, total: Number(counted?.[0]?.[0]?.[1] ?? 0), ms: Date.now() - begun };
  }
  if (req.op === "query") {
    const begun = Date.now();
    const [rows] = mariadb("SELECT * FROM (" + req.query + "\n) q LIMIT " + (QUERY_ROWS + 1));
    const columns = rows?.length ? rows[0].map((f) => f[0]) : [];
    const taken = take((rows || []).slice(0, QUERY_ROWS).map((r) => r.map((f) => cell(f[1]))));
    out.result = { columns, rows: taken.rows, truncated: taken.truncated || (rows || []).length > QUERY_ROWS, total: null, ms: Date.now() - begun };
  }
  finish(out);
}

// ---------------------------------------------------------------- MongoDB

// Runs inside mongosh, after req is set: find alone, with a 5 s limit.
const MONGO_BODY = [
  "const MAX_TEXT = 2000, BUDGET = 4 * 1024 * 1024;",
  "let used = 0;",
  "function show(v) {",
  "  if (v === null) return null;",
  "  if (v === undefined) return { missing: true };",
  "  if (typeof v === 'number' || typeof v === 'boolean') return v;",
  "  let s;",
  "  if (typeof v === 'string') s = v;",
  "  else if (v instanceof Date) s = v.toISOString();",
  "  else if (v._bsontype === 'ObjectId') s = 'ObjectId(\"' + v.toHexString() + '\")';",
  "  else if (v._bsontype === 'Binary') return { bytes: v.buffer.length };",
  "  else if (['Long', 'Decimal128', 'Int32', 'Double', 'Timestamp'].includes(v._bsontype)) s = v.toString();",
  "  else s = EJSON.stringify(v, { relaxed: true });",
  "  return s.length > MAX_TEXT ? { text: s.slice(0, MAX_TEXT), length: s.length } : s;",
  "}",
  "const infos = db.getCollectionInfos({}, { nameOnly: false, authorizedCollections: true });",
  "const tables = infos.filter((i) => !i.name.startsWith('system.'))",
  "  .map((i) => ({ name: i.name, type: i.type === 'view' ? 'view' : 'collection', rows: i.type === 'view' ? null : db.getCollection(i.name).estimatedDocumentCount() }))",
  "  .sort((a, b) => (a.name < b.name ? -1 : 1));",
  "const out = { tables };",
  "if (req.op === 'rows' || req.op === 'query') {",
  "  if (!tables.some((t) => t.name === req.table)) throw new Error('there is no collection ' + req.table);",
  "  const filter = req.op === 'query' ? EJSON.parse(req.query) : {};",
  "  const sort = {};",
  "  if (req.sort) sort[req.sort] = req.desc ? -1 : 1;",
  "  const c = db.getCollection(req.table);",
  "  const begun = Date.now();",
  "  const docs = c.find(filter).sort(sort).skip(req.offset).limit(req.limit).maxTimeMS(5000).toArray();",
  "  const columns = [];",
  "  for (const d of docs) for (const k of Object.keys(d)) if (!columns.includes(k)) columns.push(k);",
  "  if (columns.includes('_id')) columns.unshift(...columns.splice(columns.indexOf('_id'), 1));",
  "  const rows = [];",
  "  let truncated = false;",
  "  for (const d of docs) {",
  "    const row = columns.map((k) => show(d[k]));",
  "    used += JSON.stringify(row).length;",
  "    if (used > BUDGET) { truncated = true; break; }",
  "    rows.push(row);",
  "  }",
  "  out.result = { columns, rows, truncated, total: c.countDocuments(filter, { maxTimeMS: 5000 }), ms: Date.now() - begun };",
  "}",
  "print('LAYER-MONGO ' + JSON.stringify(out));",
].join("\n");

function browseMongo() {
  const uri = process.env.MONGODB_URI || "";
  if (!uri.startsWith("mongodb://")) fail("this app has no MongoDB");
  // The login goes in a script file only this job can read, never in arguments.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-"));
  const script = path.join(dir, "browse.js");
  fs.writeFileSync(script, "db = connect(" + JSON.stringify(uri + (uri.includes("?") ? "&" : "?") + "serverSelectionTimeoutMS=5000") + ");\nconst req = " + JSON.stringify(req) + ";\n" + MONGO_BODY + "\n", { mode: 0o600 });
  const r = spawnSync("/usr/bin/mongosh", ["--quiet", "--norc", "--nodb", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000, env: { ...process.env, HOME: dir } });
  fs.rmSync(dir, { recursive: true, force: true });
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("LAYER-MONGO "));
  if (r.status !== 0 || !line) fail(lastLine(r.stderr) || lastLine(r.stdout) || "mongosh failed");
  finish(JSON.parse(line.slice("LAYER-MONGO ".length)));
}

// ---------------------------------------------------------------- Redis

function browseRedis() {
  const raw = process.env.REDIS_URL || "";
  if (!raw.startsWith("redis://")) fail("this app has no Redis");
  const u = new URL(raw);
  const sock = net.connect(Number(u.port), "127.0.0.1");
  sock.setTimeout(10000, () => fail("Redis didn't answer"));
  sock.on("error", (e) => fail(e.message));
  let buf = Buffer.alloc(0);
  const waiting = [];
  // RESP2 replies: [value, next offset], or null while incomplete.
  const parse = (i) => {
    const nl = buf.indexOf("\r\n", i);
    if (nl === -1) return null;
    const type = String.fromCharCode(buf[i]);
    const line = buf.toString("utf8", i + 1, nl);
    if (type === "+") return [line, nl + 2];
    if (type === "-") return [{ error: line }, nl + 2];
    if (type === ":") return [Number(line), nl + 2];
    if (type === "$") {
      const n = Number(line);
      if (n < 0) return [null, nl + 2];
      return buf.length < nl + 4 + n ? null : [buf.toString("utf8", nl + 2, nl + 2 + n), nl + 4 + n];
    }
    if (type === "*") {
      const n = Number(line);
      if (n < 0) return [null, nl + 2];
      const items = [];
      let j = nl + 2;
      for (let k = 0; k < n; k++) {
        const p = parse(j);
        if (!p) return null;
        items.push(p[0]);
        j = p[1];
      }
      return [items, j];
    }
    fail("Redis sent something unexpected");
  };
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (waiting.length) {
      const p = parse(0);
      if (!p) return;
      buf = buf.subarray(p[1]);
      waiting.shift()(p[0]);
    }
  });
  const cmd = (...args) =>
    new Promise((resolve) => {
      waiting.push(resolve);
      sock.write(Buffer.concat([Buffer.from("*" + args.length + "\r\n"), ...args.flatMap((a) => { const b = Buffer.from(String(a)); return [Buffer.from("$" + b.length + "\r\n"), b, Buffer.from("\r\n")]; })]));
    });
  const ok = (reply) => {
    if (reply && reply.error) fail(reply.error);
    return reply;
  };
  (async () => {
    ok(await cmd("AUTH", decodeURIComponent(u.username || "default"), decodeURIComponent(u.password)));
    const pattern = req.query || "*";
    const keys = [];
    let cursor = "0";
    let rounds = 0;
    do {
      const [next, batch] = ok(await cmd("SCAN", cursor, "MATCH", pattern, "COUNT", 1000));
      cursor = next;
      keys.push(...batch);
      rounds++;
    } while (cursor !== "0" && keys.length < 500 && rounds < 100);
    keys.sort();
    const shown = keys.slice(0, 500);
    const types = await Promise.all(shown.map((k) => cmd("TYPE", k)));
    const LEN = { string: "STRLEN", hash: "HLEN", list: "LLEN", set: "SCARD", zset: "ZCARD", stream: "XLEN" };
    const lens = await Promise.all(shown.map((k, i) => (LEN[types[i]] ? cmd(LEN[types[i]], k) : null)));
    const out = { tables: shown.map((k, i) => ({ name: k, type: types[i], rows: typeof lens[i] === "number" ? lens[i] : null })), more: cursor !== "0" || keys.length > 500 };
    if (req.op === "rows") {
      const key = req.table;
      const type = ok(await cmd("TYPE", key));
      if (type === "none") fail("there's no key " + key);
      const begun = Date.now();
      const lo = req.offset;
      const hi = req.offset + req.limit - 1;
      let columns;
      let rows;
      let total;
      if (type === "string") {
        columns = ["value"];
        rows = [[cell(ok(await cmd("GET", key)))]];
        total = 1;
      } else if (type === "list") {
        columns = ["index", "value"];
        rows = ok(await cmd("LRANGE", key, lo, hi)).map((v, i) => [lo + i, cell(v)]);
        total = await cmd("LLEN", key);
      } else if (type === "zset") {
        columns = ["member", "score"];
        const flat = ok(await cmd("ZRANGE", key, lo, hi, "WITHSCORES"));
        rows = [];
        for (let i = 0; i < flat.length; i += 2) rows.push([cell(flat[i]), Number(flat[i + 1])]);
        total = await cmd("ZCARD", key);
      } else if (type === "hash" || type === "set") {
        // No offsets for hashes and sets: scan until this page is covered.
        const per = type === "hash" ? 2 : 1;
        const items = [];
        let c = "0";
        let n = 0;
        do {
          const [next, batch] = ok(await cmd(type === "hash" ? "HSCAN" : "SSCAN", key, c, "COUNT", 1000));
          c = next;
          items.push(...batch);
          n++;
        } while (c !== "0" && items.length < (hi + 1) * per && n < 1000);
        if (type === "hash") {
          columns = ["field", "value"];
          rows = [];
          for (let i = 0; i < items.length; i += 2) rows.push([cell(items[i]), cell(items[i + 1])]);
          rows = rows.slice(lo, hi + 1);
          total = await cmd("HLEN", key);
        } else {
          columns = ["member"];
          rows = items.slice(lo, hi + 1).map((m) => [cell(m)]);
          total = await cmd("SCARD", key);
        }
      } else if (type === "stream") {
        columns = ["id", "fields"];
        const entries = ok(await cmd("XRANGE", key, "-", "+", "COUNT", hi + 1));
        rows = entries.slice(lo).map(([id, fields]) => {
          const o = {};
          for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
          return [id, cell(JSON.stringify(o))];
        });
        total = await cmd("XLEN", key);
      } else {
        fail("keys of type " + type + " can't be shown yet");
      }
      const taken = take(rows);
      out.result = { columns, rows: taken.rows, truncated: taken.truncated, total, ttl: await cmd("TTL", key), ms: Date.now() - begun };
    }
    finish(out);
    sock.end();
  })().catch((e) => fail(e.message));
}

try {
  if (req.engine === "sqlite") browseSqlite();
  else if (req.engine === "postgres") browsePostgres();
  else if (req.engine === "mysql") browseMysql();
  else if (req.engine === "mongodb") browseMongo();
  else if (req.engine === "redis") browseRedis();
  else fail("unknown engine " + req.engine);
} catch (e) {
  fail(e.message);
}
`;
