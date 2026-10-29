"use client";

import { useActionState, useState } from "react";
import { addPostgresAction, addRedisAction, removePostgresAction, removeRedisAction, type ServiceState } from "@/app/actions/services";
import { CopyButton, SubmitButton } from "./form";
import { Button, Field, FormError, Input } from "./ui";

export function AddRedisForm({ slug, installed }: { slug: string; installed: boolean }) {
  const [state, action] = useActionState(addRedisAction, {} as ServiceState);
  if (state.ok) return <p className="text-[13px] text-ok">{state.ok}</p>;
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="slug" value={slug} />
      <label className="grid gap-1.5 text-[13px] font-medium">
        Memory
        <select name="memoryMb" defaultValue="64" className="h-9 rounded-md border border-border bg-background px-2 text-sm tabular-nums">
          {[32, 64, 128, 256, 512].map((mb) => (
            <option key={mb} value={mb}>
              {mb} MB
            </option>
          ))}
        </select>
      </label>
      <SubmitButton pending={installed ? "Starting Redis…" : "Installing Redis…"} className="w-auto">
        Add Redis
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}

/** A connection URL with its password hidden until asked. */
export function SecretUrl({ url }: { url: string }) {
  const [shown, setShown] = useState(false);
  const masked = url.replace(/:\/\/([^:]*):([^@]+)@/, (_m, user) => `://${user}:••••••••@`);
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-subtle px-3 py-2">
      <code className="min-w-0 truncate font-mono text-[12px]" data-testid="secret-url">
        {shown ? url : masked}
      </code>
      <span className="flex shrink-0 items-center">
        <button type="button" onClick={() => setShown((s) => !s)} className="rounded px-2 py-1 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
          {shown ? "Hide" : "Reveal"}
        </button>
        <CopyButton text={url} />
      </span>
    </div>
  );
}

export function AddPostgresForm({ slug, installed }: { slug: string; installed: boolean }) {
  const [state, action] = useActionState(addPostgresAction, {} as ServiceState);
  if (state.ok) return <p className="text-[13px] text-ok">{state.ok}</p>;
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="slug" value={slug} />
      <SubmitButton pending={installed ? "Creating the database…" : "Installing PostgreSQL…"} className="w-auto">
        Add Postgres
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}

const REMOVE = {
  redis: { action: removeRedisAction, label: "Redis", what: "Stops this app's Redis and removes REDIS_URL. The app restarts without it.", data: "Also delete its data (data/redis)" },
  postgres: {
    action: removePostgresAction,
    label: "Postgres",
    what: "Drops this app's database and role and removes DATABASE_URL. The app restarts without it.",
    data: "Don't keep a final dump on the server",
  },
} as const;

export function RemoveRedisForm({ slug }: { slug: string }) {
  return <RemoveServiceForm slug={slug} kind="redis" />;
}

export function RemovePostgresForm({ slug }: { slug: string }) {
  return <RemoveServiceForm slug={slug} kind="postgres" />;
}

function RemoveServiceForm({ slug, kind }: { slug: string; kind: keyof typeof REMOVE }) {
  const r = REMOVE[kind];
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, action] = useActionState(r.action, {} as ServiceState);
  if (state.ok) return <p className="text-[13px] text-muted">{state.ok}</p>;
  if (!open) {
    return (
      <Button type="button" variant="ghost" className="h-8 px-3 text-[13px]" onClick={() => setOpen(true)}>
        Remove {r.label}
      </Button>
    );
  }
  return (
    <form action={action} className="grid gap-3 rounded-md border border-border p-3">
      <input type="hidden" name="slug" value={slug} />
      <p className="text-[13px] text-muted">{r.what}</p>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="deleteData" className="size-4 accent-foreground" /> {r.data}
      </label>
      <Field label={`Type ${slug} to confirm`} htmlFor={`confirm-${kind}`}>
        <Input id={`confirm-${kind}`} name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <FormError message={state.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" className="h-8 px-3 text-[13px]" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={typed !== slug} className="h-8 bg-err px-3 text-[13px] text-white">
          Remove
        </Button>
      </div>
    </form>
  );
}
