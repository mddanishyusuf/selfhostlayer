"use client";

import { EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { removeProject, saveEnvAction, saveSettings, type EnvState, type SettingsState } from "@/app/actions/projects";
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

function DeleteSubmit({ disabled, slug }: { disabled: boolean; slug: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={disabled || pending}>
      {pending ? "Deleting…" : `Delete ${slug}`}
    </Button>
  );
}

export function DeleteProject({ slug }: { slug: string }) {
  const [state, action] = useActionState(removeProject, {} as SettingsState);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  return (
    <SettingsRow title="Delete project" description="Stops the app and removes its user, files, unit and Caddy site from the server. Its data/ folder is archived on the server unless you say otherwise.">
      <div>
        <Button type="button" variant="secondary" size="sm" className="border-rose/60 text-rose hover:bg-rose/10" onClick={() => setOpen(true)} data-testid="delete-project">
          Delete {slug}…
        </Button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={`Delete ${slug}`} description="This can't be undone">
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
            <DeleteSubmit disabled={typed !== slug} slug={slug} />
          </div>
        </form>
      </Modal>
    </SettingsRow>
  );
}
