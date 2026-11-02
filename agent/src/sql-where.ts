// The visual query builder's filters, as SQL, for the viewer's and the
// editor's jobs (browse-job.ts, edit-job.ts). Plain JavaScript in a string,
// pasted into both jobs: they run as `node -e`, so they can't import.
//
// A filter names a column the job has already checked exists, an operator
// from a fixed list and a value. Columns are always quoted identifiers, and
// values are always parameters (SQLite) or escaped literals (Postgres,
// MySQL): nothing the user typed becomes SQL syntax.

export const FILTER_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "not_contains", "starts", "ends", "null", "not_null", "in"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export interface Filter {
  column: string;
  op: FilterOp;
  /** A string; a list of strings for "in"; nothing for "null" and "not_null". */
  value?: string | string[];
}
export interface Where {
  match: "all" | "any";
  filters: Filter[];
}

export const WHERE_LIB = String.raw`
const COMPARE = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/**
 * " WHERE …" for a {match, filters} object, or "" for none. d is the dialect:
 * q quotes a column, v turns a value into a parameter or a literal, text
 * makes a column comparable as text, like is the operator for patterns and
 * escape the ESCAPE clause's literal (a backslash).
 */
function whereSql(where, columns, d) {
  if (!where || !where.filters || !where.filters.length) return "";
  const parts = where.filters.map((f) => {
    if (!columns.includes(f.column)) fail("there's no column " + f.column);
    const col = d.q(f.column);
    if (f.op === "null") return col + " IS NULL";
    if (f.op === "not_null") return col + " IS NOT NULL";
    if (COMPARE[f.op]) return col + " " + COMPARE[f.op] + " " + d.v(f.value);
    if (f.op === "in") return col + " IN (" + f.value.map((x) => d.v(x)).join(", ") + ")";
    const escaped = String(f.value).replace(/[\\%_]/g, (m) => "\\" + m);
    const pattern = f.op === "starts" ? escaped + "%" : f.op === "ends" ? "%" + escaped : "%" + escaped + "%";
    return d.text(col) + (f.op === "not_contains" ? " NOT " : " ") + d.like + " " + d.v(pattern) + " ESCAPE " + d.escape;
  });
  return " WHERE " + parts.map((p) => "(" + p + ")").join(where.match === "any" ? " OR " : " AND ");
}

/** The SQL dialects: SQLite binds parameters (pushed onto params), the others quote literals. */
function sqliteDialect(params) {
  return { q: (s) => '"' + s.replaceAll('"', '""') + '"', v: (x) => (params.push(x), "?"), text: (c) => c, like: "LIKE", escape: "'\\'" };
}
function postgresDialect() {
  // standard_conforming_strings is on (the default since 9.1): a backslash in '…' is just a backslash.
  const lit = (s) => "'" + String(s).replaceAll("'", "''") + "'";
  return { q: (s) => '"' + s.replaceAll('"', '""') + '"', v: lit, lit, text: (c) => c + "::text", like: "ILIKE", escape: "'\\'" };
}
function mysqlDialect() {
  const lit = (s) => "'" + String(s).replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";
  return { q: (s) => "\x60" + s.replaceAll("\x60", "\x60\x60") + "\x60", v: lit, lit, text: (c) => c, like: "LIKE", escape: "'\\\\'" };
}
`;
