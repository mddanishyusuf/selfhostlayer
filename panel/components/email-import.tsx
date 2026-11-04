"use client";

// Importing contacts (catalog/email/src/imports.ts): the file goes to Email,
// its columns are mapped here, then the import runs in Email in batches. The
// dialog can close at once: the Contacts page shows every running import, its
// progress and Shield's review, and keeps them across reloads.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import * as A from "@/app/actions/email";
import type { ImportJob, ImportMapping, List } from "@/lib/email";
import { checkLabel, type ShieldCheck } from "@/lib/shield-checks";
import { Modal } from "./modal";
import { Button, Field, FormError, Input, Select, cx } from "./ui";

type Role = "skip" | "email" | "name" | "first" | "last" | "field";

const fieldKey = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 40) || "field";

const mb = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const n = (v: number) => v.toLocaleString("en");

/** Uploads with progress (fetch can't report it): the file streams through the panel to Email. */
function upload(brandId: number, file: File, onProgress: (sent: number) => void): Promise<ImportJob> {
  return new Promise((done, fail) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/email/${brandId}/imports?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", "text/csv");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let body: (ImportJob & { error?: string }) | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status === 200 && body) done(body);
      else fail(new Error(body?.error ?? `The upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => fail(new Error("The upload was cut off: try again."));
    xhr.send(file);
  });
}

export function ImportDialog({ brandId, lists, onClose }: { brandId: number; lists: List[]; onClose: () => void }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [shield, setShield] = useState(true);
  const [review, setReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const send = async () => {
    if (!file) return;
    setError(null);
    setSent(0);
    try {
      const j = await upload(brandId, file, setSent);
      const g = j.guess;
      setRoles(j.headers.map((_, i): Role => (i === g.email ? "email" : i === g.name ? "name" : i === g.first ? "first" : i === g.last ? "last" : g.fields.some((f) => f.column === i) ? "field" : "skip")));
      setKeys(j.headers.map((h, i) => g.fields.find((f) => f.column === i)?.key ?? fieldKey(h)));
      setJob(j);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSent(null);
    }
  };

  const setRole = (i: number, role: Role) =>
    // One column each for email, name, first and last: picking it moves it.
    setRoles(roles.map((r, j) => (j === i ? role : role !== "field" && role !== "skip" && r === role ? "skip" : r)));

  const go = () =>
    start(async () => {
      if (!job) return;
      const at = (role: Role) => {
        const i = roles.indexOf(role);
        return i < 0 ? null : i;
      };
      const email = at("email");
      if (email === null) return setError("Pick the column with the email address.");
      const mapping: ImportMapping = { email, name: at("name"), first: at("first"), last: at("last"), fields: roles.flatMap((r, i) => (r === "field" ? [{ column: i, key: keys[i]! }] : [])) };
      const r = await A.startImport(brandId, job.id, { mapping, lists: picked, shield, review: shield && review, include: "clean" });
      if ("error" in r) return setError(r.error);
      router.refresh();
      onClose();
    });

  return (
    <Modal open onClose={onClose} title="Import contacts" description={job ? `${job.filename} · ${mb(job.bytes)}: say what each column is` : "From a CSV file, up to 1 GB"}>
      <div className="grid gap-4 px-[18px] py-5" data-testid="import-form">
        {!job ? (
          <>
            <Field label="CSV file" htmlFor="i-file" hint="The first row names the columns. Next you say which is the email, the name and what to keep as fields.">
              <input id="i-file" type="file" accept=".csv,text/csv" className="text-[13px]" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            {sent !== null && file && (
              <div className="grid gap-1.5 text-[12px] text-muted">
                <span>
                  Uploading… {mb(sent)} of {mb(file.size)}
                </span>
                <span className="h-1.5 bg-field">
                  <span className="block h-full bg-accent transition-[width] duration-150" style={{ width: `${Math.round((sent / Math.max(1, file.size)) * 100)}%` }} />
                </span>
              </div>
            )}
            <FormError message={error ?? undefined} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button type="button" onClick={send} disabled={!file || sent !== null} data-testid="import-upload">
                {sent !== null ? "Uploading…" : "Next"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="max-h-[320px] overflow-auto border border-border" data-testid="import-mapping">
              {job.headers.map((h, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_150px] items-center gap-3 border-b border-border-soft px-3 py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_150px_150px]">
                  <span className="grid min-w-0 gap-px">
                    <b className="truncate text-[13px]">{h || `Column ${i + 1}`}</b>
                    <span className="truncate font-mono text-[11.5px] text-muted">{job.sample.map((r) => r[i] ?? "").filter(Boolean).slice(0, 3).join(" · ") || "empty in the first rows"}</span>
                  </span>
                  <Select value={roles[i]} onChange={(e) => setRole(i, e.target.value as Role)} aria-label={`What ${h || `column ${i + 1}`} is`} className="h-[33px] text-[13px]">
                    <option value="skip">Skip it</option>
                    <option value="email">Email</option>
                    <option value="name">Name</option>
                    <option value="first">First name</option>
                    <option value="last">Last name</option>
                    <option value="field">A field</option>
                  </Select>
                  {roles[i] === "field" ? (
                    <Input value={keys[i]} onChange={(e) => setKeys(keys.map((k, j) => (j === i ? e.target.value : k)))} aria-label="Field name" className="col-span-2 h-[33px] font-mono text-[12.5px] sm:col-span-1" spellCheck={false} />
                  ) : (
                    <span className="hidden sm:block" />
                  )}
                </div>
              ))}
            </div>
            {lists.length > 0 && (
              <div className="grid gap-1.5">
                <p className="text-[13px] font-medium">Add them to</p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {lists.map((l) => (
                    <label key={l.id} className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, l.id] : picked.filter((x) => x !== l.id))} />
                      {l.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" checked={shield} onChange={(e) => setShield(e.target.checked)} className="mt-[3px]" data-testid="import-shield" />
              <span>
                Check the addresses with Shield
                <span className="block text-[12px] text-muted">Invalid, temporary and spam-listed addresses stay out, by this brand&apos;s Shield settings.</span>
              </span>
            </label>
            {shield && (
              <label className="flex items-start gap-2 pl-6 text-[13px]">
                <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} className="mt-[3px]" data-testid="import-review" />
                <span>
                  Check everything first, and show me before importing
                  <span className="block text-[12px] text-muted">Then choose to leave refused addresses out or bring them in flagged.</span>
                </span>
              </label>
            )}
            <p className="text-[12px] text-muted">It runs on the server: you can close this, or leave the page. Contacts shows its progress. Nobody who unsubscribed is subscribed again, and imports start no automation.</p>
            <FormError message={error ?? undefined} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button type="button" onClick={go} disabled={pending} data-testid="import-start">
                {pending ? "Starting…" : review && shield ? "Start checking" : "Start importing"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

const ACTIVE = new Set(["checking", "importing"]);

/** The brand's imports on Contacts: running ones with their progress, one waiting for review, and what finished today. */
export function ImportsPanel({ brandId, initial }: { brandId: number; initial: ImportJob[] }) {
  const router = useRouter();
  const [jobs, setJobs] = useState(initial);
  const [pending, start] = useTransition();
  const wasActive = useRef(initial.some((j) => ACTIVE.has(j.status)));
  useEffect(() => setJobs(initial), [initial]);
  const active = jobs.some((j) => ACTIVE.has(j.status));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      const next = await A.importJobs(brandId);
      setJobs(next);
      // One finished: the list of contacts below changed.
      if (wasActive.current && !next.some((j) => ACTIVE.has(j.status))) router.refresh();
      wasActive.current = next.some((j) => ACTIVE.has(j.status));
    }, 2000);
    return () => clearInterval(t);
  }, [active, brandId, router]);
  const shown = jobs.filter((j) => ACTIVE.has(j.status) || j.status === "review" || (j.finishedAt && Date.now() - j.finishedAt < 86_400_000));
  if (!shown.length) return null;
  const act = (run: () => Promise<unknown>) =>
    start(async () => {
      await run();
      setJobs(await A.importJobs(brandId));
      router.refresh();
    });
  return (
    <section className="grid border border-border bg-card" data-testid="imports">
      {shown.map((j) => {
        const total = j.rows;
        const done = j.status === "checking" ? j.checked : j.processed;
        const pct = total ? Math.min(100, Math.round((done / total) * 100)) : null;
        const c = j.counts;
        return (
          <div key={j.id} className="grid gap-2 border-b border-border-soft px-3.5 py-3 text-[13px] last:border-b-0" data-testid="import-job">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <b className="truncate">{j.filename}</b>
              <span className={cx("text-[12px]", j.status === "failed" ? "text-err" : j.status === "review" ? "text-warn" : "text-muted")} data-testid="import-status">
                {j.status === "checking" && `Checking with Shield… ${n(j.checked)}${total ? ` of ${n(total)}` : ""} rows`}
                {j.status === "importing" && `Importing… ${n(j.processed)}${total ? ` of ${n(total)}` : ""} rows`}
                {j.status === "review" && `Checked ${n(j.checked)} rows: waiting for you`}
                {j.status === "done" && `Imported ${n(j.processed)} rows: ${n(c.created)} added, ${n(c.updated)} updated${c.flagged ? `, ${n(c.flagged)} flagged` : ""}${c.refused ? `, ${n(c.refused)} refused by Shield` : ""}${c.skipped ? `, ${n(c.skipped)} skipped` : ""}`}
                {j.status === "failed" && `Stopped: ${j.error}`}
                {j.status === "cancelled" && `Cancelled after ${n(j.processed)} rows (what came in stays)`}
              </span>
              {ACTIVE.has(j.status) && (
                <Button type="button" variant="secondary" size="sm" className="ml-auto" disabled={pending} onClick={() => act(() => A.cancelImport(brandId, j.id))}>
                  Cancel
                </Button>
              )}
            </div>
            {ACTIVE.has(j.status) && (
              <span className="h-1.5 overflow-hidden bg-field">
                <span className={cx("block h-full bg-accent transition-[width] duration-150", pct === null && "w-1/3 [animation:pulse-ring_1.6s_infinite]")} style={pct === null ? undefined : { width: `${Math.max(2, pct)}%` }} />
              </span>
            )}
            {ACTIVE.has(j.status) && j.status === "importing" && (c.created || c.updated) > 0 && (
              <span className="text-[12px] text-muted">
                So far {n(c.created)} added, {n(c.updated)} updated{c.refused ? `, ${n(c.refused)} refused` : ""}. It runs on the server: leaving the page doesn&apos;t stop it.
              </span>
            )}
            {j.status === "review" && (
              <div className="grid gap-2.5 border border-border bg-field px-3.5 py-3" data-testid="import-review-result">
                <p>
                  <span className="text-ok">{n(j.shield.ok)} fine</span>
                  {j.shield.flag > 0 && <span className="text-warn">, {n(j.shield.flag)} flagged</span>}
                  {j.shield.refuse > 0 && <span className="text-err">, {n(j.shield.refuse)} refused</span>}
                  {" "}
                  of {n(j.shield.total)} addresses.
                </p>
                {Object.entries(j.shield.byCheck).map(([id, v]) => (
                  <div key={id} className="grid gap-0.5">
                    <span>
                      <b>{checkLabel(id)}</b>: {n(v!.count)} <span className={v!.action === "refuse" ? "text-err" : "text-warn"}>{v!.action === "refuse" ? "refused" : "flagged"}</span>
                    </span>
                    <span className="truncate text-[12px] text-muted">{j.shield.examples[id as ShieldCheck]?.map((x) => `${x.email} (${x.detail})`).join(", ")}</span>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button type="button" size="sm" disabled={pending} onClick={() => act(() => A.continueImport(brandId, j.id, "clean"))} data-testid="import-continue">
                    Import, leaving refused ones out
                  </Button>
                  {j.shield.refuse > 0 && (
                    <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => act(() => A.continueImport(brandId, j.id, "flagged"))}>
                      Import them all, refused ones flagged
                    </Button>
                  )}
                  <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => act(() => A.cancelImport(brandId, j.id))}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {j.status === "done" && j.skipped.length > 0 && (
              <details className="text-[12px] text-muted">
                <summary className="cursor-pointer">Rows skipped</summary>
                <ul className="mt-1.5 grid gap-0.5">
                  {j.skipped.slice(0, 20).map((s) => (
                    <li key={s.line}>
                      Line {s.line}: {s.reason}
                    </li>
                  ))}
                  {j.skipped.length > 20 && <li>…and more</li>}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </section>
  );
}
