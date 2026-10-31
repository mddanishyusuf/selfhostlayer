"use client";

import { DatabasePlusIcon, DownloadIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { addMongodbAction, addMysqlAction, addPostgresAction, addRedisAction, installMongodbAction, removeMongodbAction, removeMysqlAction, removePostgresAction, removeRedisAction, type ServiceState } from "@/app/actions/services";
import type { DatabaseKind } from "@/lib/services";
import { CopyButton, SubmitButton } from "./form";
import { Icon } from "./icon";
import { Modal } from "./modal";
import { Button, Field, FormError, Input, Select } from "./ui";

export function AddRedisForm({ slug, installed }: { slug: string; installed: boolean }) {
  const [state, action] = useActionState(addRedisAction, {} as ServiceState);
  if (state.ok) return <p className="text-[13px] text-teal">{state.ok}</p>;
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="slug" value={slug} />
      <div className="flex flex-wrap items-center gap-2">
        <Select name="memoryMb" defaultValue="64" aria-label="Memory" className="w-[120px] tabular-nums">
          {[32, 64, 128, 256, 512].map((mb) => (
            <option key={mb} value={mb}>
              {mb} MB
            </option>
          ))}
        </Select>
        <SubmitButton pending={installed ? "Starting Redis…" : "Installing Redis…"} className="w-auto">
          <Icon icon={PlusIcon} size={15} strokeWidth={2} /> Add Redis
        </SubmitButton>
      </div>
      <FormError message={state.error} />
    </form>
  );
}

/** A connection URL with its password hidden until asked. */
export function SecretUrl({ url }: { url: string }) {
  const [shown, setShown] = useState(false);
  const masked = url.replace(/:\/\/([^:]*):([^@]+)@/, (_m, user) => `://${user}:••••••••@`);
  return (
    <div className="flex h-[38px] min-w-0 items-center justify-between gap-2 rounded-[10px] border border-border-strong pl-3 pr-1.5">
      <code className="min-w-0 truncate font-mono text-[12.5px]" data-testid="secret-url">
        {shown ? url : masked}
      </code>
      <span className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => setShown((s) => !s)} className="h-[26px] rounded-md px-2 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
          {shown ? "Hide" : "Reveal"}
        </button>
        <CopyButton text={url} />
      </span>
    </div>
  );
}

/** A value (a password) hidden until asked, with Copy. */
export function SecretValue({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 truncate font-mono text-[13px]" data-testid="secret-value">
        {shown ? value : "••••••••••••"}
      </code>
      <button type="button" onClick={() => setShown((s) => !s)} className="h-[26px] shrink-0 rounded-md px-2 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
        {shown ? "Hide" : "Reveal"}
      </button>
      <CopyButton text={value} />
    </span>
  );
}

/** MongoDB on the server, once for every project. With start, the same install starts a stopped one and says why if it can't. */
export function InstallMongodbForm({ slug, compact = false, start = false }: { slug?: string; compact?: boolean; start?: boolean }) {
  const [state, action] = useActionState(installMongodbAction, {} as ServiceState);
  return (
    <form action={action} className="grid gap-2">
      {slug && <input type="hidden" name="slug" value={slug} />}
      <div>
        <SubmitButton pending={start ? "Starting MongoDB…" : "Installing MongoDB…"} variant={compact ? "secondary" : undefined} size={compact ? "sm" : undefined} className="w-auto">
          <Icon icon={start ? PlayIcon : DownloadIcon} size={15} strokeWidth={2} /> {start ? "Start" : compact ? "Install" : "Install MongoDB on this server"}
        </SubmitButton>
      </div>
      <FormError message={state.error} />
    </form>
  );
}

const ADD_DATABASE = {
  postgres: { action: addPostgresAction, label: "Add Postgres", icon: PlusIcon, installing: "Installing PostgreSQL…" },
  mysql: { action: addMysqlAction, label: "Add MySQL", icon: PlusIcon, installing: "Installing MariaDB…" },
  // MongoDB is installed on its own first: this only makes the project's database and user.
  mongodb: { action: addMongodbAction, label: "Create database and user", icon: DatabasePlusIcon, installing: "Creating the database…" },
} as const;

export function AddDatabaseForm({ slug, kind, installed }: { slug: string; kind: DatabaseKind; installed: boolean }) {
  const a = ADD_DATABASE[kind];
  const [state, action] = useActionState(a.action, {} as ServiceState);
  if (state.ok) return <p className="text-[13px] text-teal">{state.ok}</p>;
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="slug" value={slug} />
      <div>
        <SubmitButton pending={installed ? "Creating the database…" : a.installing} className="w-auto">
          <Icon icon={a.icon} size={15} strokeWidth={2} /> {a.label}
        </SubmitButton>
      </div>
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
  mysql: {
    action: removeMysqlAction,
    label: "MySQL",
    what: "Drops this app's database and user and removes DATABASE_URL. The app restarts without it.",
    data: "Don't keep a final dump on the server",
  },
  mongodb: {
    action: removeMongodbAction,
    label: "MongoDB",
    what: "Drops this app's database and user and removes MONGODB_URI. The app restarts without it.",
    data: "Don't keep a final dump on the server",
  },
} as const;

export function RemoveRedisForm({ slug }: { slug: string }) {
  return <RemoveServiceForm slug={slug} kind="redis" />;
}

export function RemoveDatabaseForm({ slug, kind }: { slug: string; kind: DatabaseKind }) {
  return <RemoveServiceForm slug={slug} kind={kind} />;
}

function RemoveSubmit({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={disabled || pending}>
      {pending ? "Removing…" : `Remove ${label}`}
    </Button>
  );
}

function RemoveServiceForm({ slug, kind }: { slug: string; kind: keyof typeof REMOVE }) {
  const r = REMOVE[kind];
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, action] = useActionState(r.action, {} as ServiceState);
  if (state.ok) return <p className="text-[12px] text-muted">{state.ok}</p>;
  return (
    <div>
      <Button type="button" variant="ghost" size="sm" className="-ml-3" onClick={() => setOpen(true)}>
        Remove {r.label}…
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Remove ${r.label}`} description={slug}>
        <form action={action} className="grid gap-4 px-[18px] py-5">
          <input type="hidden" name="slug" value={slug} />
          <p className="text-[12px] text-muted">{r.what}</p>
          <label className="flex items-center gap-2.5 text-[12px] text-muted">
            <input type="checkbox" name="deleteData" className="size-4 accent-rose" /> {r.data}
          </label>
          <Field label={`Type ${slug} to confirm`} htmlFor={`confirm-${kind}`}>
            <Input id={`confirm-${kind}`} name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
          </Field>
          <FormError message={state.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <RemoveSubmit disabled={typed !== slug} label={r.label} />
          </div>
        </form>
      </Modal>
    </div>
  );
}
