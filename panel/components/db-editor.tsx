"use client";

import { PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { applyEditAction, previewEditAction, type BackupPlan } from "@/app/actions/databases";
import type { Cell, ColumnInfo, EditTarget, RowKeys, Where } from "@/lib/browse";
import { DataGrid, type GridSelection } from "./data-grid";
import { Icon } from "./icon";
import { Modal } from "./modal";
import { Button, NO_AUTOFILL, cx } from "./ui";

/** A value as typed in the editor: text, or NULL. */
type Value = { text: string; isNull: boolean };

/** What a cell can be edited as; long-cut text and binary can't be (the viewer only has part of them). */
function editable(cell: Cell): Value | null {
  if (cell === null) return { text: "", isNull: true };
  if (typeof cell === "string") return { text: cell, isNull: false };
  if (typeof cell === "number" || typeof cell === "boolean") return { text: String(cell), isNull: false };
  return null;
}

const field = "w-full border border-border bg-field px-2.5 py-1.5 font-mono text-[12.5px] outline-none transition-[border-color] duration-150 focus:border-accent disabled:opacity-50";
const show = (v: string | null) => (v === null ? "NULL" : v.length > 80 ? `${JSON.stringify(v.slice(0, 80))}…` : JSON.stringify(v));

type Change = { column: string; value: string | null };
/** The editor's steps: editing one row, editing many, then reviewing before anything is written. */
type Step =
  | { kind: "row"; row: number }
  | { kind: "bulk"; scope: "selected" | "matching" }
  | { kind: "review"; target: EditTarget; label: string; set: Change[]; matches: number; backup: BackupPlan; back: Exclude<Step, { kind: "review" }> };

/**
 * A SQL table's rows with editing: pick rows (or take every row the builder's
 * filters match), set new values, review how many rows change and how the app
 * is backed up first, then confirm. Nothing is written before that.
 */
export function EditableRows({
  slug,
  db,
  table,
  columns,
  rows,
  schema,
  keys,
  total,
  where,
  firstRow,
  sortLinks,
  sorted,
}: {
  slug: string;
  db: string;
  table: string;
  columns: string[];
  rows: Cell[][];
  schema: ColumnInfo[];
  keys: RowKeys | null;
  total: number;
  where?: Where;
  firstRow: number;
  sortLinks?: string[];
  sorted?: { column: string; desc: boolean };
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const info = useMemo(() => new Map(schema.map((c) => [c.name, c])), [schema]);

  const select: GridSelection | undefined = keys
    ? {
        selected,
        toggle: (r) => setSelected((s) => (s.has(r) ? new Set([...s].filter((x) => x !== r)) : new Set([...s, r]))),
        toggleAll: () => setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((_, i) => i)))),
      }
    : undefined;

  const close = () => {
    setStep(null);
    setError(null);
  };

  /** Counts the target rows, then shows the review. */
  const review = (target: EditTarget, label: string, set: Change[], back: Exclude<Step, { kind: "review" }>) => {
    setError(null);
    start(async () => {
      const res = await previewEditAction({ slug, db, table, target });
      if (!res.ok) return setError(res.error);
      if (res.matches === 0) return setError("No rows match any more: nothing to change.");
      setStep({ kind: "review", target, label, set, matches: res.matches, backup: res.backup, back });
    });
  };

  const apply = (s: Extract<Step, { kind: "review" }>, withoutBackup: boolean) => {
    setError(null);
    start(async () => {
      const res = await applyEditAction({ slug, db, table, target: s.target, set: s.set, expect: s.matches, withoutBackup });
      if (!res.ok) return setError(res.error);
      setSelected(new Set());
      setStep(null);
      setDone(`Updated ${res.updated.toLocaleString()} row${res.updated === 1 ? "" : "s"} in ${table}.${res.backupId ? " The backup from just before is under Backups." : ""}`);
      router.refresh();
    });
  };

  const pickedKeys = (picked: number[]): EditTarget => ({ keys: { columns: keys!.columns, rows: picked.map((r) => keys!.rows[r]!) } });
  const matching: EditTarget = where ? { where } : { all: true };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2 text-[12px] text-muted" data-testid="db-edit-bar">
        {selected.size > 0 ? (
          <>
            <span className="tabular-nums text-foreground">{selected.size} selected</span>
            <Button size="sm" onClick={() => setStep({ kind: "bulk", scope: "selected" })}>
              <Icon icon={PencilIcon} size={12} /> Edit selected
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </>
        ) : (
          <span>{keys ? "Open a row to edit it, or pick rows with the checkboxes." : `${table} has no primary key: edit rows by filtering them, then "Edit all matching".`}</span>
        )}
        {total > 0 && (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setStep({ kind: "bulk", scope: "matching" })}>
            Edit all {total.toLocaleString()} {where ? "matching" : ""} rows
          </Button>
        )}
      </div>
      {done && (
        <p className="flex items-center gap-2 border-b border-border bg-selected/50 px-3.5 py-2 text-[12px] text-foreground" role="status">
          {done}
          <button type="button" aria-label="Dismiss" onClick={() => setDone(null)} className="ml-auto text-dim hover:text-foreground">
            <Icon icon={XIcon} size={13} />
          </button>
        </p>
      )}

      <DataGrid
        columns={columns}
        rows={rows}
        firstRow={firstRow}
        sortLinks={sortLinks}
        sorted={sorted}
        select={select}
        rowAction={
          keys
            ? (r) => (
                <Button size="sm" variant="secondary" onClick={() => setStep({ kind: "row", row: r })}>
                  <Icon icon={PencilIcon} size={12} /> Edit row
                </Button>
              )
            : undefined
        }
      />

      {step?.kind === "row" && (
        <RowEditor
          title={`Edit row ${firstRow + step.row}`}
          columns={columns}
          cells={rows[step.row]!}
          info={info}
          busy={pending}
          error={error}
          onClose={close}
          onSave={(set) => review(pickedKeys([step.row]), `row ${firstRow + step.row}`, set, step)}
        />
      )}
      {step?.kind === "bulk" && (
        <BulkEditor
          title={step.scope === "selected" ? `Edit ${selected.size} selected row${selected.size === 1 ? "" : "s"}` : `Edit all ${total.toLocaleString()} ${where ? "matching " : ""}rows`}
          description={step.scope === "matching" ? (where ? "Every row the filters match, not just this page." : "Every row in the table, not just this page.") : undefined}
          columns={columns}
          info={info}
          busy={pending}
          error={error}
          onClose={close}
          onSave={(set) =>
            review(
              step.scope === "selected" ? pickedKeys([...selected].sort((a, b) => a - b)) : matching,
              step.scope === "selected" ? `${selected.size} selected row${selected.size === 1 ? "" : "s"}` : where ? "every matching row" : "every row",
              set,
              step,
            )
          }
        />
      )}
      {step?.kind === "review" && <Review step={step} table={table} busy={pending} error={error} onBack={() => setStep(step.back)} onClose={close} onConfirm={(without) => apply(step, without)} />}
    </>
  );
}

/** One field: the value as text (a box for long or multi-line ones), with NULL as a checkbox when the column takes it. */
function ValueField({ id, value, onChange, nullable, disabled }: { id: string; value: Value; onChange: (v: Value) => void; nullable: boolean; disabled?: boolean }) {
  const long = value.text.length > 60 || value.text.includes("\n");
  return (
    <div className="flex items-start gap-2">
      {long ? (
        <textarea {...NO_AUTOFILL} id={id} rows={4} spellCheck={false} value={value.isNull ? "" : value.text} disabled={disabled || value.isNull} onChange={(e) => onChange({ text: e.target.value, isNull: false })} className={cx(field, "resize-y")} />
      ) : (
        <input {...NO_AUTOFILL} id={id} spellCheck={false} value={value.isNull ? "" : value.text} placeholder={value.isNull ? "NULL" : ""} disabled={disabled || value.isNull} onChange={(e) => onChange({ text: e.target.value, isNull: false })} className={cx(field, "h-[32px]")} />
      )}
      {nullable && (
        <label className="flex h-[32px] shrink-0 items-center gap-1.5 text-[12px] text-muted">
          <input type="checkbox" checked={value.isNull} disabled={disabled} onChange={(e) => onChange({ text: value.text, isNull: e.target.checked })} className="size-[14px] accent-[var(--color-accent)]" />
          NULL
        </label>
      )}
    </div>
  );
}

const typeOf = (info: ColumnInfo | undefined) => [info?.type, info?.pk ? "primary key" : null].filter(Boolean).join(" · ");

function RowEditor({ title, columns, cells, info, busy, error, onClose, onSave }: { title: string; columns: string[]; cells: Cell[]; info: Map<string, ColumnInfo>; busy: boolean; error: string | null; onClose: () => void; onSave: (set: Change[]) => void }) {
  const initial = useMemo(() => cells.map(editable), [cells]);
  const [values, setValues] = useState<(Value | null)[]>(initial);
  const changes: Change[] = columns.flatMap((c, i) => {
    const before = initial[i];
    const now = values[i];
    if (!before || !now || (before.isNull === now.isNull && (now.isNull || before.text === now.text))) return [];
    return [{ column: c, value: now.isNull ? null : now.text }];
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description="Only the values you change are written."
      footer={
        <EditorFooter busy={busy} error={error} onClose={onClose} disabled={!changes.length} label={changes.length ? `Review ${changes.length} change${changes.length === 1 ? "" : "s"}` : "Change a value"} onSave={() => onSave(changes)} />
      }
    >
      <div className="grid gap-3 px-[18px] py-3.5">
        {columns.map((c, i) => {
          const col = info.get(c);
          return (
            <div key={c} className="grid gap-1">
              <label htmlFor={`edit-${i}`} className="flex items-baseline gap-2 text-[12.5px]">
                <span className="font-mono text-foreground">{c}</span>
                <span className="text-[11.5px] text-dim">{typeOf(col)}</span>
              </label>
              {values[i] ? (
                <ValueField id={`edit-${i}`} value={values[i]!} nullable={col?.nullable ?? true} onChange={(v) => setValues((vs) => vs.map((x, j) => (j === i ? v : x)))} />
              ) : (
                <p className="text-[12px] text-dim">Too long or binary to edit here.</p>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function BulkEditor({ title, description, columns, info, busy, error, onClose, onSave }: { title: string; description?: string; columns: string[]; info: Map<string, ColumnInfo>; busy: boolean; error: string | null; onClose: () => void; onSave: (set: Change[]) => void }) {
  const [sets, setSets] = useState<{ column: string; value: Value }[]>([{ column: columns[0] ?? "", value: { text: "", isNull: false } }]);
  const used = new Set(sets.map((s) => s.column));
  const duplicate = used.size !== sets.length;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description ?? "Set columns to the same value in each of them."}
      footer={<EditorFooter busy={busy} error={error ?? (duplicate ? "Each column can be set once." : null)} onClose={onClose} disabled={!sets.length || duplicate} label="Review change" onSave={() => onSave(sets.map((s) => ({ column: s.column, value: s.value.isNull ? null : s.value.text })))} />}
    >
      <div className="grid gap-3 px-[18px] py-3.5">
        {sets.map((s, i) => {
          const col = info.get(s.column);
          return (
            <div key={i} className="grid gap-1.5 sm:grid-cols-[200px_minmax(0,1fr)_auto] sm:items-start">
              <select aria-label="Column" value={s.column} onChange={(e) => setSets((xs) => xs.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))} className={cx(field, "h-[32px]")}>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <ValueField id={`set-${i}`} value={s.value} nullable={col?.nullable ?? true} onChange={(v) => setSets((xs) => xs.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
              <button type="button" aria-label="Remove" onClick={() => setSets((xs) => xs.filter((_, j) => j !== i))} className="grid size-[32px] place-items-center text-dim transition-colors hover:text-foreground">
                <Icon icon={XIcon} size={14} />
              </button>
              {col && <span className="text-[11.5px] text-dim sm:col-start-2">{typeOf(col)}</span>}
            </div>
          );
        })}
        <div>
          <Button size="sm" variant="secondary" disabled={sets.length >= columns.length} onClick={() => setSets((xs) => [...xs, { column: columns.find((c) => !used.has(c)) ?? columns[0] ?? "", value: { text: "", isNull: false } }])}>
            <Icon icon={PlusIcon} size={13} /> Set another column
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EditorFooter({ busy, error, onClose, onSave, disabled, label }: { busy: boolean; error: string | null; onClose: () => void; onSave: () => void; disabled: boolean; label: string }) {
  return (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      {error && <p className="mr-auto text-[12px] text-rose">{error}</p>}
      <Button variant="secondary" size="sm" onClick={onClose}>
        Cancel
      </Button>
      <Button size="sm" disabled={disabled || busy} onClick={onSave}>
        {busy ? "Counting rows…" : label}
      </Button>
    </div>
  );
}

function ago(at: number): string {
  const min = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return min < 1 ? "less than a minute ago" : `${min} minute${min === 1 ? "" : "s"} ago`;
}

function Review({ step, table, busy, error, onBack, onClose, onConfirm }: { step: Extract<Step, { kind: "review" }>; table: string; busy: boolean; error: string | null; onBack: () => void; onClose: () => void; onConfirm: (withoutBackup: boolean) => void }) {
  const [accepted, setAccepted] = useState(false);
  const none = step.backup.kind === "none";
  const backupNote: ReactNode =
    step.backup.kind === "new" ? (
      "The app is backed up first (listed under Backups as “before an edit”), so this can be undone by restoring it."
    ) : step.backup.kind === "recent" ? (
      `The app was backed up ${ago(step.backup.at)}; that backup covers this change too. Restore it from Backups to undo.`
    ) : (
      <>
        <b className="font-medium text-foreground">No backup storage is connected</b>, so this change can&apos;t be undone. Connect a bucket under Server → Backups to have every edit backed up first.
      </>
    );
  return (
    <Modal
      open
      onClose={onClose}
      title={`Update ${step.matches.toLocaleString()} row${step.matches === 1 ? "" : "s"} in ${table}?`}
      description={`Changes ${step.label}, in one transaction.`}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {error && <p className="mr-auto text-[12px] text-rose">{error}</p>}
          <Button variant="secondary" size="sm" onClick={onBack} disabled={busy}>
            Back
          </Button>
          <Button size="sm" variant={none ? "danger" : "primary"} disabled={busy || (none && !accepted)} onClick={() => onConfirm(none)}>
            {busy ? (step.backup.kind === "new" ? "Backing up, then updating…" : "Updating…") : `Update ${step.matches.toLocaleString()} row${step.matches === 1 ? "" : "s"}`}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 px-[18px] py-3.5 text-[13px]">
        <dl className="grid grid-cols-[minmax(80px,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5 border border-border bg-field px-3 py-2.5 font-mono text-[12.5px]">
          {step.set.map((s) => (
            <div key={s.column} className="contents">
              <dt className="text-muted">{s.column}</dt>
              <dd className="break-all">→ {show(s.value)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[12.5px] text-muted">{backupNote}</p>
        <p className="text-[12px] text-dim">If the number of matching rows changes before this runs, nothing is written.</p>
        {none && (
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="size-[14px] accent-[var(--color-accent)]" />
            I understand this can&apos;t be undone
          </label>
        )}
      </div>
    </Modal>
  );
}
