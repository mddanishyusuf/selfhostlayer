"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { encodeWhere, FILTER_OPS, type Filter, type FilterOp, type Where } from "@/lib/where";
import { Icon } from "./icon";
import { Button, NO_AUTOFILL, cx } from "./ui";

/** A filter being typed: "in" takes its list as comma-separated text until it runs. */
type Draft = { column: string; op: FilterOp; value: string };

const toDraft = (f: Filter): Draft => ({ column: f.column, op: f.op, value: Array.isArray(f.value) ? f.value.join(", ") : (f.value ?? "") });

function toFilter(d: Draft): Filter | null {
  const def = FILTER_OPS.find((o) => o.op === d.op)!;
  if (def.takes === "none") return { column: d.column, op: d.op };
  if (def.takes === "list") {
    const list = d.value.split(",").map((v) => v.trim()).filter(Boolean);
    return list.length ? { column: d.column, op: d.op, value: list } : null;
  }
  return { column: d.column, op: d.op, value: d.value };
}

const field = "h-[30px] border border-border bg-field px-2 text-[12.5px] outline-none transition-[border-color] duration-150 focus:border-accent";

/**
 * The viewer's visual query builder for SQL databases: a table, then filters
 * of "column, operator, value" that all or any must match. Running it opens
 * the table's rows narrowed by them (the w= parameter); the agent turns them
 * into SQL with quoted names and values (agent/src/sql-where.ts).
 */
export function QueryBuilder({
  tables,
  table,
  columns,
  where,
  base,
  db,
}: {
  tables: string[];
  table?: string;
  columns: string[];
  where?: Where;
  /** The viewer's path and its db= value: a table and its filters open there (sort and page reset). */
  base: string;
  db: string;
}) {
  const router = useRouter();
  const hrefFor = (t: string | undefined, w: string | undefined) => {
    const u = new URLSearchParams({ db });
    if (t) u.set("t", t);
    if (w) u.set("w", w);
    return `${base}?${u}`;
  };
  const [drafts, setDrafts] = useState<Draft[]>(() => where?.filters.map(toDraft) ?? []);
  const [match, setMatch] = useState<Where["match"]>(where?.match ?? "all");

  const update = (i: number, next: Partial<Draft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...next } : d)));
  const run = (ds = drafts, m = match) => {
    const filters = ds.map(toFilter).filter((f): f is Filter => !!f);
    router.push(hrefFor(table, encodeWhere(filters.length ? { match: m, filters } : undefined)));
  };
  const columnOptions = columns.length ? columns : drafts.map((d) => d.column);

  return (
    <div className="grid gap-2.5" data-testid="db-builder">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="w-[52px] text-muted">Table</span>
        <select aria-label="Table" value={table ?? ""} onChange={(e) => router.push(hrefFor(e.target.value || undefined, undefined))} className={cx(field, "min-w-[180px] font-mono")}>
          {!table && <option value="">Pick a table…</option>}
          {tables.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {table &&
        drafts.map((d, i) => {
          const def = FILTER_OPS.find((o) => o.op === d.op)!;
          return (
            <div key={i} className="flex flex-wrap items-center gap-2 text-[12.5px]" data-testid="db-filter">
              <span className="w-[52px] text-muted">
                {i === 0 ? (
                  "Where"
                ) : i === 1 ? (
                  <select aria-label="Match" value={match} onChange={(e) => setMatch(e.target.value as Where["match"])} className={cx(field, "w-[52px] px-1")}>
                    <option value="all">and</option>
                    <option value="any">or</option>
                  </select>
                ) : match === "all" ? (
                  "and"
                ) : (
                  "or"
                )}
              </span>
              <select aria-label="Column" value={d.column} onChange={(e) => update(i, { column: e.target.value })} className={cx(field, "min-w-[140px] font-mono")}>
                {columnOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select aria-label="Operator" value={d.op} onChange={(e) => update(i, { op: e.target.value as FilterOp })} className={cx(field, "min-w-[120px]")}>
                {FILTER_OPS.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </select>
              {def.takes !== "none" && (
                <input
                  {...NO_AUTOFILL}
                  aria-label="Value"
                  value={d.value}
                  spellCheck={false}
                  placeholder={def.takes === "list" ? "a, b, c" : "Value"}
                  onChange={(e) => update(i, { value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      run();
                    }
                  }}
                  className={cx(field, "min-w-[160px] flex-1 font-mono")}
                />
              )}
              <button type="button" aria-label="Remove filter" onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))} className="grid size-[30px] place-items-center text-dim transition-colors hover:text-foreground">
                <Icon icon={XIcon} size={14} />
              </button>
            </div>
          );
        })}

      {table && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => run()}>
            Run
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={!columnOptions.length} onClick={() => setDrafts((ds) => [...ds, { column: columnOptions[0] ?? "", op: "eq", value: "" }])}>
            <Icon icon={PlusIcon} size={13} /> Add filter
          </Button>
          {(drafts.length > 0 || where) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDrafts([]);
                run([], "all");
              }}
            >
              Clear filters
            </Button>
          )}
          <span className="ml-auto text-[12px] text-dim">Read-only until you edit rows below</span>
        </div>
      )}
    </div>
  );
}
