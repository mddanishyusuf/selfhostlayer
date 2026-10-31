"use client";

import { CheckIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useActionState, useState } from "react";
import { addMongodbAction, addMysqlAction, addPostgresAction, addRedisAction, type ServiceState } from "@/app/actions/services";
import { ENGINE_LOOK } from "./engines";
import { SubmitButton } from "./form";
import { Icon } from "./icon";
import { MENU_ITEM, MoreMenu } from "./menu";
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
        <Icon icon={PlusIcon} size={15} strokeWidth={2} /> Add a database
      </Button>
      <Modal open={open} onClose={close} title="Add a database" description="It goes to one app, with a login only that app has.">
        <div className="grid gap-2.5 px-[18px] pb-2 pt-5 sm:grid-cols-2" role="radiogroup" aria-label="Engine">
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
                  "relative grid content-start gap-1 border p-2.5 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55",
                  on ? "border-accent bg-accent-soft" : "border-border bg-transparent enabled:hover:border-accent",
                )}
              >
                <span className="mb-2.5">
                  <TileIcon tone={look.tone} size="sm">
                    <Icon icon={look.icon} size={17} />
                  </TileIcon>
                </span>
                <b className="font-bold">{KINDS[o.kind].name}</b>
                <span className="text-[12px] leading-normal text-muted">{KINDS[o.kind].what}</span>
                {why && <span className="text-[12px] text-dim">{why}</span>}
                <span className={cx("absolute right-3.5 top-3.5 grid size-[18px] place-items-center rounded-full border-[1.5px]", on ? "border-accent bg-accent text-white" : "border-border-strong")}>
                  {on && <Icon icon={CheckIcon} size={11} strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </div>
        {picked ? (
          <AddForm key={picked.kind} option={picked} onCancel={close} />
        ) : (
          <div className="mt-3 flex justify-end gap-2 border-t border-border px-[18px] pb-5 pt-3.5">
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
      <div className="grid gap-3 px-[18px] pb-4 pt-3">
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
        <p className="text-[12px] text-muted">The app restarts without downtime to pick up its new login.</p>
        <FormError message={state.error} />
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-[18px] pb-5 pt-3.5">
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

function CopyUrlItem({ url, close }: { url: string; close: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      className={MENU_ITEM}
      onClick={async () => {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(close, 700);
      }}
    >
      {copied ? "Copied" : "Copy connection URL"}
    </button>
  );
}

/** A database row's "…": copy its connection URL, or open its app's Databases page. */
export function DatabaseMenu({ slug, url }: { slug: string; url?: string }) {
  return (
    <MoreMenu label={`More for ${slug}`} width={230} iconSize={18} buttonClassName="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-well hover:text-foreground">
      {(close) => (
        <>
          {url && <CopyUrlItem url={url} close={close} />}
          <Link role="menuitem" href={`/projects/${slug}/databases`} className={MENU_ITEM} onClick={close}>
            Open {slug}&apos;s databases
          </Link>
        </>
      )}
    </MoreMenu>
  );
}
