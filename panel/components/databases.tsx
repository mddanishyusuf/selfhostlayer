"use client";

import { Add01Icon, MoreHorizontalIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { addMongodbAction, addMysqlAction, addPostgresAction, addRedisAction, type ServiceState } from "@/app/actions/services";
import { ENGINE_LOOK } from "./engines";
import { SubmitButton } from "./form";
import { Icon } from "./icon";
import { Modal } from "./modal";
import { TileIcon } from "./page";
import { Button, FormError, Select, cx } from "./ui";

type Kind = "postgres" | "mysql" | "mongodb" | "redis";

/** One choice in the Add a database dialog. */
export interface AddOption {
  kind: Kind;
  /** The apps that can take one: no SQL database yet for Postgres and MySQL, none of this kind for the others. */
  apps: string[];
  installed: boolean;
  /** Why it can't be picked yet. */
  blocked?: string;
}

const KINDS: Record<Kind, { name: string; what: string; action: typeof addPostgresAction; installing: string }> = {
  postgres: { name: "Postgres", what: "A role and database on the shared server, handed over as DATABASE_URL.", action: addPostgresAction, installing: "Installing Postgres…" },
  mysql: { name: "MySQL (MariaDB)", what: "A user and database on the shared server, handed over as DATABASE_URL.", action: addMysqlAction, installing: "Installing MariaDB…" },
  mongodb: { name: "MongoDB", what: "A user and database that can reach only its own, handed over as MONGODB_URI.", action: addMongodbAction, installing: "Creating the database…" },
  redis: { name: "Redis", what: "Its own small Redis with a password and a memory cap, handed over as REDIS_URL.", action: addRedisAction, installing: "Installing Redis…" },
};

/** "Add a database": pick an engine and the app it's for. The project's Databases page opens with the result. */
export function AddDatabaseDialog({ options }: { options: AddOption[] }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null);
  const picked = options.find((o) => o.kind === kind);
  const close = () => setOpen(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <Icon icon={Add01Icon} size={15} strokeWidth={2} /> Add a database
      </Button>
      <Modal open={open} onClose={close} title="Add a database" description="It goes to one app, with a login only that app has.">
        <div className="grid gap-2.5 px-6 pb-2 pt-5 sm:grid-cols-2" role="radiogroup" aria-label="Engine">
          {options.map((o) => {
            const look = ENGINE_LOOK[o.kind];
            const why = o.blocked ?? (o.apps.length === 0 ? "Every app has one already." : !o.installed && o.kind !== "mongodb" ? "Installs first, about a minute." : null);
            const disabled = !!o.blocked || o.apps.length === 0;
            const on = kind === o.kind;
            return (
              <button
                key={o.kind}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={disabled}
                onClick={() => setKind(o.kind)}
                className={cx(
                  "relative grid content-start gap-1 rounded-xl border px-4 pb-4 pt-3.5 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55",
                  on ? "border-accent bg-accent/[0.05] shadow-[inset_0_0_0_1px_var(--accent)]" : "border-border-strong bg-card enabled:hover:border-dim",
                )}
              >
                <span className="mb-2.5">
                  <TileIcon tone={look.tone} size="sm">
                    <Icon icon={look.icon} size={17} />
                  </TileIcon>
                </span>
                <b className="font-semibold">{KINDS[o.kind].name}</b>
                <span className="text-[13px] leading-normal text-muted">{KINDS[o.kind].what}</span>
                {why && <span className="text-[12.5px] text-muted">{why}</span>}
                <span className={cx("absolute right-3.5 top-3.5 grid size-[18px] place-items-center rounded-full border-[1.5px]", on ? "border-accent bg-accent text-white" : "border-border-strong")}>
                  {on && <Icon icon={Tick02Icon} size={11} strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </div>
        {picked ? (
          <AddForm key={picked.kind} option={picked} onCancel={close} />
        ) : (
          <div className="mt-3 flex justify-end gap-2 border-t border-border px-6 pb-5 pt-3.5">
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="button" disabled>
              Add database
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}

function AddForm({ option, onCancel }: { option: AddOption; onCancel: () => void }) {
  const k = KINDS[option.kind];
  const [state, action] = useActionState(k.action, {} as ServiceState);
  return (
    <form action={action}>
      <div className="grid gap-3 px-6 pb-4 pt-3">
        <label className="grid gap-1.5">
          <span className="text-[13px] font-medium">For</span>
          <Select name="slug" defaultValue={option.apps[0]} aria-label="App">
            {option.apps.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </Select>
        </label>
        {option.kind === "redis" && (
          <label className="grid gap-1.5">
            <span className="text-[13px] font-medium">Memory</span>
            <Select name="memoryMb" defaultValue="64" aria-label="Memory" className="tabular-nums">
              {[32, 64, 128, 256, 512].map((mb) => (
                <option key={mb} value={mb}>
                  {mb} MB
                </option>
              ))}
            </Select>
          </label>
        )}
        <p className="text-[13px] text-muted">The app restarts without downtime to pick up its new login.</p>
        <FormError message={state.error} />
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-6 pb-5 pt-3.5">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <SubmitButton pending={option.installed ? "Creating the database…" : k.installing} className="w-auto">
          Add database
        </SubmitButton>
      </div>
    </form>
  );
}

/** A database row's "…": copy its connection URL, or open its app's Databases page. */
export function DatabaseMenu({ slug, url }: { slug: string; url?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const item = "flex h-9 w-full items-center rounded-lg px-2.5 text-left text-[13.5px] transition-colors hover:bg-well";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`More for ${slug}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-well hover:text-foreground"
      >
        <Icon icon={MoreHorizontalIcon} size={18} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-20 grid min-w-[230px] gap-0.5 rounded-xl border border-border bg-card p-1 shadow-pop">
          {url && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setOpen(false), 700);
              }}
            >
              {copied ? "Copied" : "Copy connection URL"}
            </button>
          )}
          <Link role="menuitem" href={`/projects/${slug}/databases`} className={item}>
            Open {slug}&apos;s databases
          </Link>
        </div>
      )}
    </div>
  );
}
