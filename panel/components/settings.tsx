"use client";

import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { removeProject, saveSettings, type SettingsState } from "@/app/actions/projects";
import { parseDotEnv } from "@/lib/project-settings";
import { Button, Card, Field, FormError, Input, Label, cx } from "./ui";

export interface SettingsDefaults {
  slug: string;
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

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="grid gap-5 p-6">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-[13px] text-muted">{description}</p>}
      </div>
      {children}
    </Card>
  );
}

const Err = ({ msg }: { msg?: string }) => (msg ? <p className="text-[13px] text-err">{msg}</p> : null);

function EnvEditor({ initial, error }: { initial: [string, string][]; error?: string }) {
  const [rows, setRows] = useState<{ key: string; value: string }[]>(initial.length ? initial.map(([key, value]) => ({ key, value })) : [{ key: "", value: "" }]);
  const [reveal, setReveal] = useState(false);
  const [paste, setPaste] = useState("");
  // Functional updates: two changes before a re-render (autofill, a password
  // manager filling name and value at once) must both survive.
  const set = (i: number, patch: Partial<{ key: string; value: string }>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const vars = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

  return (
    <div className="grid gap-3">
      <input type="hidden" name="env" value={JSON.stringify(vars)} />
      <div className="grid gap-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
            <Input aria-label="Name" placeholder="NAME" value={r.key} spellCheck={false} autoComplete="off" className="font-mono text-[13px]" onChange={(e) => set(i, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} />
            <Input aria-label="Value" placeholder="value" value={r.value} type={reveal ? "text" : "password"} spellCheck={false} autoComplete="off" className="font-mono text-[13px]" onChange={(e) => set(i, { value: e.target.value })} />
            <button type="button" title="Remove" onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : [{ key: "", value: "" }]))} className="grid size-9 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
              <Trash2 className="size-4" aria-hidden />
              <span className="sr-only">Remove</span>
            </button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" className="h-8 px-3 text-[13px]" onClick={() => setRows((prev) => [...prev, { key: "", value: "" }])}>
          <Plus className="size-3.5" aria-hidden /> Add variable
        </Button>
        <Button type="button" variant="ghost" className="h-8 px-3 text-[13px]" onClick={() => setReveal(!reveal)}>
          {reveal ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />} {reveal ? "Hide values" : "Show values"}
        </Button>
      </div>
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-3 py-2 text-[13px] text-muted">Paste a .env file</summary>
        <div className="grid gap-2 border-t border-border p-3">
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} spellCheck={false} placeholder={"DATABASE_URL=postgres://…\nAPI_KEY=…"} className="w-full rounded-md border border-border bg-background p-2 font-mono text-[12.5px] outline-none focus:border-muted" />
          <Button
            type="button"
            variant="secondary"
            className="h-8 justify-self-start px-3 text-[13px]"
            onClick={() => {
              const parsed = parseDotEnv(paste);
              setRows((prev) => {
                const merged = new Map(prev.filter((r) => r.key).map((r) => [r.key, r.value]));
                for (const [k, v] of Object.entries(parsed)) merged.set(k, v);
                return [...merged].map(([key, value]) => ({ key, value }));
              });
              setPaste("");
            }}
          >
            Add these variables
          </Button>
        </div>
      </details>
      <p className="text-[12px] text-muted">Encrypted in the panel; on the server only the app's own process sees them (also during the build, for NEXT_PUBLIC_* and similar).</p>
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

export function SettingsForm({ d, isNew, framework }: { d: SettingsDefaults; isNew: boolean; framework: string }) {
  const [state, action] = useActionState(saveSettings, {} as SettingsState);
  const [runtime, setRuntime] = useState(d.runtime);
  const e = state.errors ?? {};
  return (
    <form action={action} className="grid gap-6">
      <input type="hidden" name="slug" value={d.slug} />
      <Section title="Build" description={`Detected ${framework} with ${d.packageManager}. Change anything that's wrong.`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Branch" htmlFor="branch" hint="Pushes to this branch deploy automatically.">
            <Input id="branch" name="branch" defaultValue={d.branch} spellCheck={false} />
            <Err msg={e.branch} />
          </Field>
          <Field label="Node version" htmlFor="nodeVersion" hint="Exact version; installed on the server if needed.">
            <Input id="nodeVersion" name="nodeVersion" defaultValue={d.nodeVersion} spellCheck={false} />
            <Err msg={e.nodeVersion} />
          </Field>
          <Field label="Install command" htmlFor="installCommand" hint={`Empty: ${d.packageManager} with the lockfile.`}>
            <Input id="installCommand" name="installCommand" defaultValue={d.installCommand} placeholder="(automatic)" spellCheck={false} className="font-mono text-[13px]" />
            <Err msg={e.installCommand} />
          </Field>
          <Field label="Build command" htmlFor="buildCommand" hint="Empty: no build step.">
            <Input id="buildCommand" name="buildCommand" defaultValue={d.buildCommand} placeholder="(none)" spellCheck={false} className="font-mono text-[13px]" />
            <Err msg={e.buildCommand} />
          </Field>
        </div>
      </Section>

      <Section title="Run" description="A Node server runs as its own sandboxed user; static files are served by Caddy with no process.">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How it runs">
          {(["node", "static"] as const).map((kind) => (
            <label key={kind} className={cx("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2.5 text-[13px] transition-colors duration-150", runtime === kind ? "border-foreground" : "border-border hover:bg-hover")}>
              <input type="radio" name="runtime" value={kind} checked={runtime === kind} onChange={() => setRuntime(kind)} className="accent-current" />
              <span className="font-medium">{kind === "node" ? "Node.js server" : "Static files"}</span>
            </label>
          ))}
        </div>
        {runtime === "node" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start command" htmlFor="startCommand" hint="Begins with node, npm or npx. PORT and HOST are set for you.">
              <Input id="startCommand" name="startCommand" defaultValue={d.startCommand} spellCheck={false} className="font-mono text-[13px]" />
              <Err msg={e.startCommand} />
            </Field>
            <Field label="Health check path" htmlFor="healthPath" hint="Must answer before traffic switches.">
              <Input id="healthPath" name="healthPath" defaultValue={d.healthPath} spellCheck={false} className="font-mono text-[13px]" />
              <Err msg={e.healthPath} />
            </Field>
            <Field label="Writable folders" htmlFor="writablePaths" hint="Inside the project, comma-separated. data/ is always writable.">
              <Input id="writablePaths" name="writablePaths" defaultValue={d.writablePaths} placeholder="(none)" spellCheck={false} className="font-mono text-[13px]" />
              <Err msg={e.writablePaths} />
            </Field>
            <Field label="Memory limit (MB)" htmlFor="memoryMb" hint="The app is restarted if it goes over.">
              <Input id="memoryMb" name="memoryMb" type="number" min={128} max={16384} defaultValue={d.memoryMb} />
              <Err msg={e.memoryMb} />
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Output folder" htmlFor="outputDir" hint="What the build produces, e.g. dist.">
              <Input id="outputDir" name="outputDir" defaultValue={d.outputDir} spellCheck={false} className="font-mono text-[13px]" />
              <Err msg={e.outputDir} />
            </Field>
            <div className="grid content-start gap-1.5">
              <Label htmlFor="spa">Single-page app</Label>
              <label className="flex items-center gap-2 text-[13px] text-muted">
                <input id="spa" name="spa" type="checkbox" defaultChecked={d.spa} /> Serve index.html for unknown paths
              </label>
            </div>
            <input type="hidden" name="memoryMb" value={d.memoryMb} />
          </div>
        )}
      </Section>

      <Section title="Environment variables">
        <EnvEditor initial={d.env} error={e.env} />
      </Section>

      <FormError message={e.form} />
      {state.saved && <p className="text-right text-[13px] text-ok">Saved. The next deploy uses these settings.</p>}
      <SaveButtons isNew={isNew} />
    </form>
  );
}

export function DeleteProject({ slug }: { slug: string }) {
  const [state, action] = useActionState(removeProject, {} as SettingsState);
  const [typed, setTyped] = useState("");
  return (
    <Card className="grid gap-4 border-err/40 p-6">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold tracking-tight">Delete project</h2>
        <p className="text-[13px] text-muted">Stops the app and removes its user, files, unit and Caddy site from the server. Its data/ folder is archived on the server unless you tick the box.</p>
      </div>
      <form action={action} className="grid gap-3">
        <input type="hidden" name="slug" value={slug} />
        <Field label={`Type ${slug} to confirm`} htmlFor="confirm">
          <Input id="confirm" name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input name="deleteData" type="checkbox" /> Also delete data/ (no archive)
        </label>
        <FormError message={state.errors?.delete} />
        <Button type="submit" disabled={typed !== slug} className="justify-self-end bg-err text-white hover:opacity-90">
          Delete {slug}
        </Button>
      </form>
    </Card>
  );
}
