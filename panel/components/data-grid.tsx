"use client";

import Link from "next/link";
import { Fragment, useState, type ReactNode } from "react";
import type { Cell } from "@/lib/browse";
import { NO_AUTOFILL, cx } from "./ui";

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

/** JSON text (a document, a json column) indented, for the open row. */
function pretty(text: string): string {
  if (!/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** One value: NULL and binary in a quieter color, cut text with its full length. */
function Value({ cell, open = false }: { cell: Cell; open?: boolean }) {
  if (cell === null) return <span className="italic text-dim">NULL</span>;
  if (typeof cell === "boolean") return <span className="text-muted">{String(cell)}</span>;
  if (typeof cell === "number") return <>{cell}</>;
  if (typeof cell === "string") return <>{open ? pretty(cell) : cell}</>;
  if ("missing" in cell) return null;
  if ("bytes" in cell) return <span className="text-dim">{size(cell.bytes)} binary</span>;
  return (
    <>
      {cell.text}
      <span className="text-dim"> … {cell.length.toLocaleString()} characters</span>
    </>
  );
}

/** Picking rows to edit: a checkbox per row and one for the page. */
export interface GridSelection {
  selected: ReadonlySet<number>;
  toggle: (row: number) => void;
  toggleAll: () => void;
}

/**
 * Rows of a table, a collection or a Redis key. A row opens to show every
 * value whole (up to the agent's 2000 characters). With sortLinks, column
 * names sort the table. With select, rows can be picked (for editing), and
 * rowAction adds buttons to an open row.
 */
export function DataGrid({
  columns,
  rows,
  firstRow,
  sortLinks,
  sorted,
  select,
  rowAction,
}: {
  columns: string[];
  rows: Cell[][];
  firstRow: number;
  sortLinks?: string[];
  sorted?: { column: string; desc: boolean };
  select?: GridSelection;
  rowAction?: (row: number) => ReactNode;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const all = !!select && rows.length > 0 && select.selected.size === rows.length;
  const box = "size-[14px] cursor-pointer accent-[var(--color-accent)]";
  return (
    <div className="max-h-[calc(100dvh-250px)] overflow-auto" data-testid="data-grid">
      <table className="w-max min-w-full border-collapse font-mono text-[12.5px]">
        <thead className="sticky top-0 z-[1]">
          <tr>
            {select && (
              <th className="w-[36px] border-b border-border bg-card py-2 pl-4 sm:pl-6">
                <input type="checkbox" aria-label="Pick every row on this page" checked={all} onChange={select.toggleAll} className={box} />
              </th>
            )}
            <th className="border-b border-border bg-card py-2 pl-4 pr-3 text-right font-sans text-[12px] font-medium text-dim sm:pl-6">#</th>
            {columns.map((c, i) => (
              <th key={i} className="whitespace-nowrap border-b border-border bg-card px-3 py-2 text-left font-sans text-[12px] font-medium text-muted">
                {sortLinks ? (
                  <Link href={sortLinks[i]!} className={cx("transition-colors duration-150 hover:text-foreground", sorted?.column === c && "text-foreground")}>
                    {c}
                    {sorted?.column === c ? (sorted.desc ? " ↓" : " ↑") : ""}
                  </Link>
                ) : (
                  c
                )}
              </th>
            ))}
            {/* Takes the spare width, so a narrow table stays at the left. */}
            <th className="w-full border-b border-border bg-card" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <Fragment key={r}>
              <tr onClick={() => setOpen(open === r ? null : r)} className={cx("cursor-pointer transition-colors duration-150 hover:bg-hover", (open === r || select?.selected.has(r)) && "bg-selected")}>
                {select && (
                  <td className="border-b border-border py-1.5 pl-4 sm:pl-6" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Pick row ${firstRow + r}`} checked={select.selected.has(r)} onChange={() => select.toggle(r)} className={box} />
                  </td>
                )}
                <td className="border-b border-border py-1.5 pl-4 pr-3 text-right text-dim tabular-nums sm:pl-6">{firstRow + r}</td>
                {row.map((cell, c) => (
                  <td key={c} className={cx("max-w-[340px] truncate whitespace-nowrap border-b border-border px-3 py-1.5", typeof cell === "number" && "text-right tabular-nums")}>
                    <Value cell={cell} />
                  </td>
                ))}
                <td className="border-b border-border" />
              </tr>
              {open === r && (
                <tr className="bg-selected/50">
                  <td colSpan={select ? 2 : 1} className="border-b border-border" />
                  <td colSpan={columns.length + 1} className="border-b border-border px-3 py-3">
                    {rowAction && <div className="mb-3 flex gap-2 font-sans">{rowAction(r)}</div>}
                    <dl className="grid max-w-[960px] grid-cols-[minmax(72px,max-content)_minmax(0,1fr)] gap-x-5 gap-y-2">
                      {columns.map((c, i) => (
                        <Fragment key={i}>
                          <dt className="font-sans text-[12px] text-muted">{c}</dt>
                          <dd className="whitespace-pre-wrap break-all">
                            <Value cell={row[i]!} open />
                          </dd>
                        </Fragment>
                      ))}
                    </dl>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The query or filter box: ⌘/Ctrl+Enter runs it. */
export function QueryBox({ name, defaultValue, placeholder, lines }: { name: string; defaultValue: string; placeholder: string; lines: number }) {
  return (
    <textarea
      {...NO_AUTOFILL}
      name={name}
      defaultValue={defaultValue}
      placeholder={placeholder}
      rows={lines}
      spellCheck={false}
      aria-label="Query"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.currentTarget.form?.requestSubmit();
        }
      }}
      className="w-full resize-y rounded-[10px] border border-border-strong bg-field px-3 py-2.5 font-mono text-[13px] leading-relaxed outline-none transition-[border-color] duration-150 placeholder:text-dim focus:border-accent"
    />
  );
}
