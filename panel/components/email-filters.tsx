"use client";

import { SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { Icon } from "./icon";
import { NO_AUTOFILL, Select } from "./ui";

/**
 * Contacts' filters on one bar: the search taking the room, then the list and
 * the status as dropdowns, applied as soon as one is picked (the search on
 * Enter). A plain GET form underneath, so it works before the page hydrates.
 */
export function ContactFilters({ path, q, list, status, lists }: { path: string; q?: string; list?: string; status?: string; lists: { id: number; name: string; total: number }[] }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const apply = () => {
    const data = new FormData(form.current!);
    const p = new URLSearchParams();
    for (const [k, v] of data) if (typeof v === "string" && v) p.set(k, v);
    router.push(p.size ? `${path}?${p}` : path);
  };
  return (
    <form
      ref={form}
      action={path}
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_200px_170px]"
      role="search"
      data-testid="contact-filters"
    >
      <label className="flex h-[39px] min-w-0 items-center gap-2 border border-border bg-field px-2.5 focus-within:border-accent">
        <Icon icon={SearchIcon} size={14} className="shrink-0 text-muted" />
        <input name="q" defaultValue={q} placeholder="Search by email or name" aria-label="Search" className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder" {...NO_AUTOFILL} />
      </label>
      <Select name="list" defaultValue={list ?? ""} onChange={apply} aria-label="List">
        <option value="">All lists</option>
        {lists.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name} ({l.total.toLocaleString("en")})
          </option>
        ))}
      </Select>
      <Select name="status" defaultValue={status ?? ""} onChange={apply} aria-label="Status">
        <option value="">Any status</option>
        <option value="subscribed">Subscribed</option>
        <option value="unconfirmed">Unconfirmed</option>
        <option value="unsubscribed">Unsubscribed</option>
        <option value="bounced">Bounced</option>
        <option value="complained">Complained</option>
        <option value="flagged">Flagged by Shield</option>
      </Select>
    </form>
  );
}
