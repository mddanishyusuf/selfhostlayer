"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { restoreBackupAction, saveDestinationAction, testDestinationAction, type DestinationState, type RestoreState } from "@/app/actions/backups";
import { SubmitButton } from "./form";
import { Modal } from "./modal";
import { Button, Field, FormError, Input, SecretInput, cx } from "./ui";

export interface ProviderInfo {
  id: string;
  label: string;
  endpoint: string;
  region: string;
  hint: string;
}

export interface DestinationDefaults {
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  prefix: string;
}

export function DestinationForm({ providers, saved }: { providers: ProviderInfo[]; saved: DestinationDefaults | null }) {
  const [state, action] = useActionState(saveDestinationAction, {} as DestinationState);
  const [provider, setProvider] = useState(saved?.provider ?? "r2");
  const info = providers.find((p) => p.id === provider)!;
  // Region follows the provider until the user types one (R2 is always "auto").
  const [region, setRegion] = useState(saved?.region ?? info.region);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="provider" value={provider} />
      <div className="inline-flex flex-wrap gap-0.5 justify-self-start rounded-lg border border-border-strong p-[3px]" role="radiogroup" aria-label="Storage provider">
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={provider === p.id}
            onClick={() => {
              setProvider(p.id);
              if (p.region || provider === "r2") setRegion(p.region);
            }}
            className={cx("h-7 rounded-md px-3 text-[13px] font-medium transition-colors duration-150", provider === p.id ? "bg-selected text-foreground" : "text-muted hover:text-foreground")}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="text-[13px] text-muted">{info.hint}</p>
      <div className="grid gap-4 sm:grid-cols-[1.6fr_1fr]">
        <Field label="Endpoint" htmlFor="endpoint">
          <Input id="endpoint" name="endpoint" defaultValue={saved?.endpoint} placeholder={info.endpoint} autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
        </Field>
        <Field label="Region" htmlFor="region">
          <Input id="region" name="region" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Bucket" htmlFor="bucket">
          <Input id="bucket" name="bucket" defaultValue={saved?.bucket} placeholder="my-backups" autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
        </Field>
        <Field label="Folder (optional)" htmlFor="prefix" hint="Backups go under <folder>/<server>/.">
          <Input id="prefix" name="prefix" defaultValue={saved?.prefix} placeholder="layer/" autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Access key ID" htmlFor="accessKeyId">
          <Input id="accessKeyId" name="accessKeyId" defaultValue={saved?.accessKeyId} autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
        </Field>
        <Field label="Secret access key" htmlFor="secretAccessKey" hint={saved ? "Leave empty to keep the saved one." : undefined}>
          <SecretInput id="secretAccessKey" name="secretAccessKey" className="font-mono text-[13px]" />
        </Field>
      </div>
      <FormError message={state.error} />
      {state.ok && <p className="text-[13px] text-ok">{state.ok}</p>}
      <div className="flex justify-end">
        <SubmitButton pending="Testing the connection…" className="w-auto">
          {saved ? "Test and save" : "Connect"}
        </SubmitButton>
      </div>
    </form>
  );
}

export function TestConnectionButton() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<DestinationState>({});
  return (
    <div className="flex items-center gap-3">
      {result.ok && <span className="text-[13px] text-ok">{result.ok}</span>}
      {result.error && <span className="text-[13px] text-err">{result.error}</span>}
      <Button type="button" variant="secondary" className="h-8 px-3 text-[13px]" disabled={pending} onClick={() => start(async () => setResult(await testDestinationAction()))}>
        {pending ? "Testing…" : "Test connection"}
      </Button>
    </div>
  );
}

/** Refreshes the page every 2s while something is running. */
export function RefreshWhile({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}

export function RestoreButton({ id, slug }: { id: number; slug: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, action] = useActionState(restoreBackupAction, {} as RestoreState);
  return (
    <>
      {state.ok ? (
        <span className="text-[13px] text-teal">Restored</span>
      ) : (
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Restore
        </Button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={`Restore ${slug}`} description="From this backup">
        {state.ok ? (
          <div className="grid gap-4 px-6 py-5">
            <p className="text-[14px] text-teal">{state.ok}</p>
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <form action={action} className="grid gap-4 px-6 py-5">
            <input type="hidden" name="id" value={id} />
            <p className="text-[13.5px] text-muted">
              The app stops, its data folder is replaced by this backup, and it starts again. The current data is kept beside it (data.before-restore-…) until the next restore.
            </p>
            <Field label={`Type ${slug} to confirm`} htmlFor={`confirm-${id}`}>
              <Input id={`confirm-${id}`} name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
            </Field>
            <FormError message={state.error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <RestoreSubmit disabled={typed !== slug} />
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

function RestoreSubmit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={disabled || pending}>
      {pending ? "Restoring…" : "Restore this backup"}
    </Button>
  );
}

const fileSize = (bytes: number) => (bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`);

interface ImportResponse {
  ok?: boolean;
  error?: string;
  sqlite?: { path: string }[];
  files?: number;
  bytes?: number;
  restarted?: string[];
  previous?: string;
}

/**
 * A data/ archive from another server: pick it, type the app name, and it
 * uploads with progress. The agent checks it before anything is replaced.
 */
export function ImportData({ slug }: { slug: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<"confirm" | "uploading" | "importing" | "done" | "error">("confirm");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const busy = phase === "uploading" || phase === "importing";

  const start = () => {
    if (!file) return;
    setPhase("uploading");
    setProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${slug}/import?confirm=${encodeURIComponent(typed)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
    xhr.upload.onload = () => setPhase("importing");
    xhr.onload = () => {
      let body: ImportResponse = {};
      try {
        body = JSON.parse(xhr.responseText) as ImportResponse;
      } catch {
        // not JSON: a proxy error page
      }
      if (xhr.status === 200 && body.ok) {
        const dbs = body.sqlite?.length ?? 0;
        setMessage(
          `Imported ${body.files} file${body.files === 1 ? "" : "s"} (${fileSize(body.bytes ?? 0)})${dbs ? `, ${dbs} SQLite database${dbs === 1 ? "" : "s"} checked` : ""}.` +
            (body.restarted?.length ? ` ${slug} restarted on the new data.` : "") +
            ` The replaced data is kept in ${body.previous} until the next import or restore.`,
        );
        setPhase("done");
        router.refresh();
      } else {
        setMessage(body.error ?? `The import failed (HTTP ${xhr.status}). Nothing changed.`);
        setPhase("error");
      }
    };
    xhr.onerror = () => {
      setMessage("The upload was interrupted. Nothing changed.");
      setPhase("error");
    };
    xhr.send(file);
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    if (phase === "done") setFile(null);
    setPhase("confirm");
    setTyped("");
  };

  return (
    <div className="grid gap-3" data-testid="import-data">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex h-9 min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-[10px] border border-dashed border-border-strong px-3 text-[13.5px] text-muted transition-colors duration-150 hover:border-accent hover:text-foreground">
          <input
            type="file"
            name="archive"
            accept=".tar.gz,.tgz,.tar,application/gzip,application/x-tar"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <span className="truncate">{file ? `${file.name} · ${fileSize(file.size)}` : "Choose a .tar.gz…"}</span>
        </label>
        <Button type="button" variant="secondary" disabled={!file} onClick={() => setOpen(true)}>
          Import…
        </Button>
      </div>
      <Modal open={open} onClose={close} title={`Import data into ${slug}`} description={file ? `${file.name} · ${fileSize(file.size)}` : undefined}>
        <div className="grid gap-4 px-6 py-5">
          {phase === "done" ? (
            <p className="text-[14px] text-teal">{message}</p>
          ) : busy ? (
            <div className="grid gap-2" aria-live="polite">
              <div className="h-1.5 overflow-hidden rounded bg-track">
                <div className="h-full rounded bg-lavender transition-[width] duration-150" style={{ width: `${Math.round((phase === "importing" ? 1 : progress) * 100)}%` }} />
              </div>
              <p className="text-[13.5px] text-muted">{phase === "uploading" ? `Uploading… ${Math.round(progress * 100)}%` : "Checking the databases and importing…"}</p>
            </div>
          ) : (
            <>
              <p className="text-[13.5px] text-muted">
                The app&apos;s data folder is replaced by this archive. SQLite databases are checked first; if anything is wrong, nothing changes. The current data is kept beside it until the next import or restore.
              </p>
              <Field label={`Type ${slug} to confirm`} htmlFor="import-confirm">
                <Input id="import-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
              </Field>
              {phase === "error" && <FormError message={message} />}
            </>
          )}
          <div className="flex justify-end gap-2">
            {phase === "done" ? (
              <Button type="button" variant="secondary" onClick={close}>
                Close
              </Button>
            ) : (
              <>
                <Button type="button" variant="secondary" onClick={close} disabled={busy}>
                  Cancel
                </Button>
                <Button type="button" onClick={start} disabled={busy || typed !== slug}>
                  {busy ? "Importing…" : phase === "error" ? "Try again" : "Import"}
                </Button>
              </>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
