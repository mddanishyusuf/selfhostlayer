"use client";

import { EyeIcon, EyeOffIcon, FileLockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { saveIntegrationSettings, type IntegrationSettingsState } from "@/app/actions/integrations";
import { deleteFileAction, removeProject, saveEnvAction, saveFileAction, saveSettings, type EnvState, type FileState, type SettingsState } from "@/app/actions/projects";
import { badDotEnvLines, formatDotEnv, parseDotEnv } from "@/lib/project-settings";
import { Icon } from "./icon";
import { Modal } from "./modal";
import { SettingsRow } from "./page";
import { Button, Field, FormError, Input, NO_AUTOFILL, SecretInput, cx } from "./ui";

export interface SettingsDefaults {
  slug: string;
  repo: string;
  branch: string;
  installCommand: string;
  buildCommand: string;
  runtime: "node" | "static";
  startCommand: string;
  healthPath: string;
  writablePaths: string;
  outputDir: string;
  spa: boolean;
  nodeVersion: string;
  memoryMb: number;
  packageManager: string;
  env: [string, string][];
}

const Err = ({ msg }: { msg?: string }) => (msg ? <p className="text-[13px] text-rose">{msg}</p> : null);

type EnvRow = { key: string; value: string };
const toRows = (vars: [string, string][]): EnvRow[] => (vars.length ? vars.map(([key, value]) => ({ key, value })) : [{ key: "", value: "" }]);

/** Name/value rows, or the same variables as .env text. Posts them as one JSON field named "env". */
export function EnvEditor({ initial, error }: { initial: [string, string][]; error?: string }) {
  const [rows, setRows] = useState<EnvRow[]>(toRows(initial));
  const [reveal, setReveal] = useState(false);
  // The .env text while editing as text; null while editing rows.
  const [text, setText] = useState<string | null>(null);
  // Functional updates: two changes before a re-render must both survive.
  const set = (i: number, patch: Partial<EnvRow>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const named = rows.filter((r) => r.key.trim()).map((r): [string, string] => [r.key.trim(), r.value]);
  const vars = text === null ? Object.fromEntries(named) : parseDotEnv(text);
  const bad = text === null ? [] : badDotEnvLines(text);
  const switchTo = (mode: "rows" | "text") => {
    if (mode === "text" && text === null) setText(formatDotEnv(named));
    if (mode === "rows" && text !== null) {
      setRows(toRows(Object.entries(parseDotEnv(text))));
      setText(null);
    }
  };

  return (
    <div className="grid gap-3">
      <input type="hidden" name="env" value={JSON.stringify(vars)} />
      {text === null ? (
        <div className="grid gap-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
              <Input aria-label="Name" placeholder="NAME" value={r.key} spellCheck={false} className="font-mono text-[13px]" onChange={(e) => set(i, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} />
              <SecretInput aria-label="Value" placeholder="value" value={r.value} reveal={reveal} className="font-mono text-[13px]" onChange={(e) => set(i, { value: e.target.value })} />
              <button
                type="button"
                title="Remove"
                onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : [{ key: "", value: "" }]))}
                className="grid size-[38px] place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground"
              >
                <Icon icon={Trash2Icon} size={16} />
                <span className="sr-only">Remove</span>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-1.5">
          <textarea
            {...NO_AUTOFILL}
            aria-label=".env"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(18, Math.max(6, text.split("\n").length + 1))}
            wrap="off"
            spellCheck={false}
            autoFocus
            placeholder={"DATABASE_URL=postgres://…\nAPI_KEY=…"}
            className="w-full rounded-[10px] border border-border-strong bg-field p-3 font-mono text-[13px] leading-relaxed outline-none placeholder:text-dim focus:border-accent"
          />
          <p className={cx("text-[12.5px]", bad.length ? "text-gold" : "text-dim")}>
            {bad.length
              ? `${bad.length === 1 ? "Line" : "Lines"} ${bad.join(", ")} ${bad.length === 1 ? "isn't" : "aren't"} KEY=value, so ${bad.length === 1 ? "it's" : "they're"} left out.`
              : "One KEY=value per line. Paste a whole .env file; comments and export are fine."}
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {text === null && (
          <>
            <Button type="button" variant="secondary" size="sm" onClick={() => setRows((prev) => [...prev, { key: "", value: "" }])}>
              <Icon icon={PlusIcon} size={14} /> Add variable
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setReveal(!reveal)}>
              <Icon icon={reveal ? EyeOffIcon : EyeIcon} size={14} /> {reveal ? "Hide values" : "Show values"}
            </Button>
          </>
        )}
        <div className="ml-auto inline-flex gap-0.5 rounded-lg border border-border-strong p-[3px]" role="group" aria-label="Edit as">
          {(
            [
              ["rows", "Rows"],
              ["text", "Raw .env"],
            ] as const
          ).map(([mode, label]) => {
            const on = (mode === "text") === (text !== null);
            return (
              <button key={mode} type="button" data-mode={mode} aria-pressed={on} onClick={() => switchTo(mode)} className={cx("flex h-[22px] items-center rounded-md px-2.5 text-[12.5px] font-medium transition-colors duration-150", on ? "bg-selected text-foreground" : "text-muted hover:text-foreground")}>
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <Err msg={error} />
    </div>
  );
}

function SaveButtons({ isNew }: { isNew: boolean }) {
  const { pending, data } = useFormStatus();
  const intent = data?.get("intent");
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {!isNew && (
        <Button type="submit" name="intent" value="save" variant="secondary" disabled={pending}>
          {pending && intent === "save" ? "Saving…" : "Save"}
        </Button>
      )}
      <Button type="submit" name="intent" value="deploy" disabled={pending}>
        {pending && intent === "deploy" ? "Starting…" : isNew ? "Deploy" : "Save and redeploy"}
      </Button>
    </div>
  );
}

/** Two choices as one pill group (radio inputs, so the form posts the value). */
function Segmented<T extends string>({ name, value, options, onChange, label }: { name: string; value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="inline-flex flex-wrap gap-0.5 justify-self-start rounded-lg border border-border-strong p-[3px]" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <label key={v} className={cx("flex h-7 cursor-pointer items-center rounded-md px-3 text-[13px] font-medium transition-colors duration-150", value === v ? "bg-selected text-foreground" : "text-muted hover:text-foreground")}>
          <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} className="sr-only" />
          {text}
        </label>
      ))}
    </div>
  );
}

export function SettingsForm({ d, isNew, framework }: { d: SettingsDefaults; isNew: boolean; framework: string }) {
  const [state, action] = useActionState(saveSettings, {} as SettingsState);
  const [runtime, setRuntime] = useState(d.runtime);
  const e = state.errors ?? {};
  return (
    <form action={action}>
      <input type="hidden" name="slug" value={d.slug} />
      <SettingsRow title="Source" description="Pushes to the branch deploy automatically.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Repository" htmlFor="repository">
            <Input id="repository" value={d.repo} disabled className="opacity-70" />
          </Field>
          <Field label="Branch" htmlFor="branch">
            <Input id="branch" name="branch" defaultValue={d.branch} spellCheck={false} />
            <Err msg={e.branch} />
          </Field>
        </div>
      </SettingsRow>

      <SettingsRow title="Build" description={`Detected ${framework} with ${d.packageManager}. Empty fields use what was detected.`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Install command" htmlFor="installCommand" hint={`Empty: ${d.packageManager} with the lockfile`}>
            <Input id="installCommand" name="installCommand" defaultValue={d.installCommand} placeholder="(automatic)" spellCheck={false} className="font-mono text-[13px]" />
            <Err msg={e.installCommand} />
          </Field>
          <Field label="Build command" htmlFor="buildCommand" hint="Empty: no build step">
            <Input id="buildCommand" name="buildCommand" defaultValue={d.buildCommand} placeholder="(none)" spellCheck={false} className="font-mono text-[13px]" />
            <Err msg={e.buildCommand} />
          </Field>
        </div>
        <Field label="Node version" htmlFor="nodeVersion" hint="An exact version, installed on the server if needed">
          <Input id="nodeVersion" name="nodeVersion" defaultValue={d.nodeVersion} spellCheck={false} className="max-w-[160px] font-mono text-[13px]" />
          <Err msg={e.nodeVersion} />
        </Field>
      </SettingsRow>

      <SettingsRow title="Run" description="A Node server runs as its own Linux user in a systemd sandbox. Static files are served by Caddy with no process.">
        <Segmented
          name="runtime"
          label="How it runs"
          value={runtime}
          onChange={setRuntime}
          options={[
            ["node", "Node.js server"],
            ["static", "Static files"],
          ]}
        />
        {runtime === "node" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Start command" htmlFor="startCommand" hint="Begins with node, npm or npx. PORT and HOST are set for you">
                <Input id="startCommand" name="startCommand" defaultValue={d.startCommand} spellCheck={false} className="font-mono text-[13px]" />
                <Err msg={e.startCommand} />
              </Field>
            </div>
            <Field label="Health check path" htmlFor="healthPath" hint="Must answer before traffic switches">
              <Input id="healthPath" name="healthPath" defaultValue={d.healthPath} spellCheck={false} className="font-mono text-[13px]" />
              <Err msg={e.healthPath} />
            </Field>
            <Field label="Writable folders" htmlFor="writablePaths" hint="Inside the project, comma-separated. data/ is always writable">
              <Input id="writablePaths" name="writablePaths" defaultValue={d.writablePaths} placeholder="(none)" spellCheck={false} className="font-mono text-[13px]" />
              <Err msg={e.writablePaths} />
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Output folder" htmlFor="outputDir" hint="What the build produces, e.g. dist">
              <Input id="outputDir" name="outputDir" defaultValue={d.outputDir} spellCheck={false} className="font-mono text-[13px]" />
              <Err msg={e.outputDir} />
            </Field>
            <label className="flex items-center gap-2.5 self-center text-[13.5px] sm:mt-5">
              <input id="spa" name="spa" type="checkbox" defaultChecked={d.spa} className="size-4 accent-lavender" /> Single-page app: serve index.html for unknown paths
            </label>
          </div>
        )}
      </SettingsRow>

      {runtime === "node" ? (
        <SettingsRow title="Resources" description="The app restarts if it goes over the memory limit, so one app can't freeze the server.">
          <Field label="Memory limit (MB)" htmlFor="memoryMb" hint="128 to 16384">
            <Input id="memoryMb" name="memoryMb" type="number" min={128} max={16384} defaultValue={d.memoryMb} className="max-w-[160px] tabular-nums" />
            <Err msg={e.memoryMb} />
          </Field>
        </SettingsRow>
      ) : (
        <input type="hidden" name="memoryMb" value={d.memoryMb} />
      )}

      {isNew && (
        <SettingsRow title="Environment variables" description="Encrypted in the panel. On the server only the app's own process sees them, also during the build (for NEXT_PUBLIC_* and similar).">
          <EnvEditor initial={d.env} error={e.env} />
        </SettingsRow>
      )}

      <div className="grid gap-3 border-b border-border px-3.5 py-5">
        <FormError message={e.form} />
        {state.saved && <p className="text-right text-[13px] text-teal">Saved. The next deploy uses these settings.</p>}
        <SaveButtons isNew={isNew} />
      </div>
    </form>
  );
}

function ApplyButtons({ isStatic, live }: { isStatic: boolean; live: boolean }) {
  const { pending, data } = useFormStatus();
  const intent = data?.get("intent");
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="submit" name="intent" value="save" variant={live ? "secondary" : "primary"} disabled={pending}>
        {pending && intent === "save" ? "Saving…" : "Save"}
      </Button>
      {live && (
        <Button type="submit" name="intent" value="apply" disabled={pending}>
          {pending && intent === "apply" ? "Starting…" : isStatic ? "Save and redeploy" : "Save and restart"}
        </Button>
      )}
    </div>
  );
}

/** The Environment page's form: the editor and its save buttons. */
export function EnvForm({ slug, initial, isStatic, live }: { slug: string; initial: [string, string][]; isStatic: boolean; live: boolean }) {
  const [state, action] = useActionState(saveEnvAction, {} as EnvState);
  return (
    <form action={action}>
      <input type="hidden" name="slug" value={slug} />
      <SettingsRow
        title="Your variables"
        description={
          isStatic
            ? "A static site reads them at build time, so saving and redeploying rebuilds it."
            : "Save and restart loads them without a rebuild and without downtime. Variables read at build time (NEXT_PUBLIC_*) need a redeploy."
        }
      >
        <EnvEditor initial={initial} error={state.error} />
        {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
        <ApplyButtons isStatic={isStatic} live={live} />
      </SettingsRow>
    </form>
  );
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`);

function RemoveFile({ slug, path }: { slug: string; path: string }) {
  const [state, action] = useActionState(deleteFileAction, {} as FileState);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} aria-label={`Remove ${path}`}>
        <Icon icon={Trash2Icon} size={14} />
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Remove ${path}?`} description="The next deploy leaves it out, so an app that needs it won't start. The live release keeps its copy until then.">
        <form action={action} className="flex justify-end gap-2 px-[18px] py-5">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="path" value={path} />
          <FormError message={state.error} />
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="danger">
            Remove
          </Button>
        </form>
      </Modal>
    </>
  );
}

function FileButtons({ live }: { live: boolean }) {
  const { pending, data } = useFormStatus();
  const intent = data?.get("intent");
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="submit" name="intent" value="save" variant={live ? "secondary" : "primary"} disabled={pending}>
        {pending && intent === "save" ? "Saving…" : "Save file"}
      </Button>
      {live && (
        <Button type="submit" name="intent" value="apply" disabled={pending}>
          {pending && intent === "apply" ? "Starting…" : "Save and redeploy"}
        </Button>
      )}
    </div>
  );
}

/**
 * Private files: files a project needs that aren't in Git (a service account
 * key). Their contents never come back to the browser: saving a path again
 * replaces the file.
 */
export function PrivateFiles({ slug, files, isStatic, live }: { slug: string; files: { path: string; bytes: number }[]; isStatic: boolean; live: boolean }) {
  const [state, action] = useActionState(saveFileAction, {} as FileState);
  const form = useRef<HTMLFormElement>(null);
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  useEffect(() => {
    if (!state.done) return;
    form.current?.reset();
    setPath("");
    setContent("");
  }, [state.done]);
  const choose = async (file: File | undefined) => {
    if (!file) return;
    setContent(await file.text());
    if (!path) setPath(file.name);
  };
  return (
    <SettingsRow
      title="Private files"
      description={
        <>
          Files the app needs that aren&apos;t in Git, like <code className="font-mono text-[12px]">serviceAccountKey.json</code>. They&apos;re kept encrypted, and each deploy writes them
          into the project&apos;s root (or a folder in it) before the build, readable by the app alone. Saving a path again replaces it.
          {isStatic && " A static site only uses them while it builds: anything the build copies into its output is public."}
        </>
      }
    >
      {files.length > 0 && (
        <div className="grid border border-border">
          {files.map((f) => (
            <div key={f.path} className="flex items-center gap-2.5 border-b border-border-soft px-3 py-2 last:border-b-0">
              <Icon icon={FileLockIcon} size={15} className="text-muted" />
              <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{f.path}</code>
              <span className="text-[12px] text-muted tabular-nums">{kb(f.bytes)}</span>
              <RemoveFile slug={slug} path={f.path} />
            </div>
          ))}
        </div>
      )}
      <form ref={form} action={action} className="grid gap-3">
        <input type="hidden" name="slug" value={slug} />
        <Field label="Path in the project" htmlFor="file-path" hint="Relative to the project's root: serviceAccountKey.json, config/key.json">
          <Input id="file-path" name="path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="serviceAccountKey.json" spellCheck={false} className="font-mono text-[13px]" />
        </Field>
        <Field
          label="Contents"
          htmlFor="file-content"
          hint={
            <>
              Paste it, or{" "}
              <label className="cursor-pointer text-accent hover:underline">
                choose the file
                <input type="file" className="sr-only" onChange={(e) => void choose(e.target.files?.[0])} />
              </label>
              . It&apos;s never shown again: to change it, save it again.
            </>
          }
        >
          <textarea
            id="file-content"
            name="content"
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            {...NO_AUTOFILL}
            placeholder='{ "type": "service_account", … }'
            className="w-full border border-border bg-field px-2.5 py-2 font-mono text-[12.5px] leading-[1.5] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-placeholder focus:border-accent focus:shadow-focus"
          />
        </Field>
        <FormError message={state.error} />
        {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
        <FileButtons live={live} />
      </form>
    </SettingsRow>
  );
}

/** An integration's settings: what its manifest leaves to the owner (the memory limit, from the manifest's minimum up). */
export function IntegrationSettingsForm({ slug, name, memoryMb, min }: { slug: string; name: string; memoryMb: number; min: number }) {
  const [state, action] = useActionState(saveIntegrationSettings, {} as IntegrationSettingsState);
  return (
    <form action={action}>
      <input type="hidden" name="slug" value={slug} />
      <SettingsRow title="Resources" description={`${name} restarts if it goes over the memory limit, so it can't freeze the server. How it starts and runs comes with each version.`}>
        <Field label="Memory limit (MB)" htmlFor="memoryMb" hint={`${min} to 16384`}>
          <Input id="memoryMb" name="memoryMb" type="number" min={min} max={16384} defaultValue={memoryMb} className="max-w-[160px] tabular-nums" />
          <Err msg={state.error} />
        </Field>
      </SettingsRow>
      <div className="grid gap-3 border-b border-border px-3.5 py-5">
        {state.saved && <p className="text-right text-[13px] text-teal">{state.saved}</p>}
        <SaveButtons isNew={false} />
      </div>
    </form>
  );
}

function DeleteSubmit({ disabled, slug, verb }: { disabled: boolean; slug: string; verb: "Delete" | "Uninstall" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={disabled || pending}>
      {pending ? (verb === "Delete" ? "Deleting…" : "Uninstalling…") : `${verb} ${slug}`}
    </Button>
  );
}

/** Deletes a project, or uninstalls an integration (integration: its name), after typing its name. */
export function DeleteProject({ slug, integration }: { slug: string; integration?: string }) {
  const [state, action] = useActionState(removeProject, {} as SettingsState);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const verb = integration ? "Uninstall" : "Delete";
  return (
    <SettingsRow
      title={integration ? `Uninstall ${integration}` : "Delete project"}
      description={`Stops ${integration ? "it" : "the app"} and removes its user, files, unit, cron jobs and Caddy site from the server. Its data/ folder is archived on the server unless you say otherwise.`}
    >
      <div>
        <Button type="button" variant="secondary" size="sm" className="border-rose/60 text-rose hover:bg-rose/10" onClick={() => setOpen(true)} data-testid={integration ? "uninstall" : "delete-project"}>
          {verb} {slug}…
        </Button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={`${verb} ${slug}`} description="This can't be undone">
        <form action={action} className="grid gap-4 px-[18px] py-5">
          <input type="hidden" name="slug" value={slug} />
          <p className="text-[12px] text-muted">The app stops and its user, files, systemd unit and Caddy site are removed. Domains stop answering. Backups in your bucket are kept.</p>
          <Field label={`Type ${slug} to confirm`} htmlFor="confirm">
            <Input id="confirm" name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
          </Field>
          <label className="flex items-center gap-2.5 text-[12px] text-muted">
            <input name="deleteData" type="checkbox" className="size-4 accent-rose" /> Also delete data/ (no archive)
          </label>
          <FormError message={state.errors?.delete} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <DeleteSubmit disabled={typed !== slug} slug={slug} verb={verb} />
          </div>
        </form>
      </Modal>
    </SettingsRow>
  );
}
