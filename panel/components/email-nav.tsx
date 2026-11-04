"use client";

// Email's own sidebar, beside the panel's (shrunk to its icons): the brand
// picker at the top, then the brand's pages. On phones it's a picker and a row
// of tabs above the page.
import { BookTextIcon, ChartColumnIcon, CheckIcon, ChevronsUpDownIcon, FileCode2Icon, GlobeIcon, KeyRoundIcon, LayoutDashboardIcon, LayoutGridIcon, ListIcon, PlusIcon, PuzzleIcon, RefreshCwIcon, ScrollTextIcon, SendIcon, SettingsIcon, ShieldCheckIcon, UsersIcon, WorkflowIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { AddBrandDialog } from "./email-forms";
import { BrandLogo } from "./email-logo";
import { Icon, type IconSvgElement } from "./icon";
import { Dropdown, MENU_ITEM } from "./menu";
import { cx } from "./ui";

export interface NavBrand {
  id: number;
  name: string;
  contacts: number;
  domain: string | null;
}

const SECTIONS: { path: string; label: string; icon: IconSvgElement }[] = [
  { path: "", label: "Overview", icon: LayoutDashboardIcon },
  { path: "/insights", label: "Insights", icon: ChartColumnIcon },
  { path: "/campaigns", label: "Campaigns", icon: SendIcon },
  { path: "/automations", label: "Automations", icon: WorkflowIcon },
  { path: "/contacts", label: "Contacts", icon: UsersIcon },
  { path: "/sync", label: "Sync", icon: RefreshCwIcon },
  { path: "/shield", label: "Shield", icon: ShieldCheckIcon },
  { path: "/lists", label: "Lists", icon: ListIcon },
  { path: "/templates", label: "Templates", icon: FileCode2Icon },
  { path: "/logs", label: "Logs", icon: ScrollTextIcon },
  { path: "/api", label: "API", icon: KeyRoundIcon },
  { path: "/domains", label: "Domains", icon: GlobeIcon },
  { path: "/settings", label: "Settings", icon: SettingsIcon },
];

const ITEM = "flex w-full cursor-pointer select-none items-center gap-[9px] px-[9px] py-1.5 text-left text-foreground transition-colors duration-150 hover:bg-card";
const ICON = "grid w-[15px] shrink-0 place-items-center opacity-75";

/** The section after /email/<brand>: the first part of the rest of the path. */
function useSection(brand: number): string {
  const pathname = usePathname();
  const rest = pathname.slice(`/email/${brand}`.length);
  const first = rest.match(/^\/[^/]+/)?.[0] ?? "";
  return SECTIONS.some((s) => s.path === first) ? first : "";
}

function BrandPicker({ brands, current, wide }: { brands: NavBrand[]; current: NavBrand; wide?: boolean }) {
  const router = useRouter();
  const section = useSection(current.id);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Dropdown
        label="Pick a brand"
        align="left"
        width={wide ? 260 : 220}
        buttonClassName="flex w-full items-center gap-2 p-2 text-left transition-colors duration-150 hover:bg-card"
        trigger={
          <>
            <BrandLogo name={current.name} domain={current.domain} size={28} />
            <span className="grid min-w-0 flex-1 leading-tight">
              <b className="truncate font-bold" data-testid="brand-picker">
                {current.name}
              </b>
              <span className="truncate text-[11.5px] text-muted">Email</span>
            </span>
            <span className="text-muted">
              <Icon icon={ChevronsUpDownIcon} size={14} />
            </span>
          </>
        }
      >
        {(close) => (
          <>
            {brands.map((b) => (
              <button
                key={b.id}
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  router.push(`/email/${b.id}${section}`);
                }}
              >
                <BrandLogo name={b.name} domain={b.domain} size={18} />
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                {b.id === current.id && <Icon icon={CheckIcon} size={14} />}
                <span className="text-[12px] tabular-nums text-dim" title="Subscribed contacts">
                  {b.contacts.toLocaleString("en")}
                </span>
              </button>
            ))}
            <div className="my-1 h-px bg-border" />
            <Link role="menuitem" href="/email" className={MENU_ITEM} onClick={close} data-testid="all-brands">
              <span className="grid w-4 shrink-0 place-items-center">
                <Icon icon={LayoutGridIcon} size={14} />
              </span>
              All brands
            </Link>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                close();
                setAdding(true);
              }}
              data-testid="new-brand"
            >
              <span className="grid w-4 shrink-0 place-items-center">
                <Icon icon={PlusIcon} size={14} />
              </span>
              Add a brand
            </button>
          </>
        )}
      </Dropdown>
      {adding && <AddBrandDialog onClose={() => setAdding(false)} />}
    </>
  );
}

export function EmailNav({ brands, current, manage, version }: { brands: NavBrand[]; current: NavBrand; manage: string; version: string | null }) {
  const section = useSection(current.id);
  return (
    <aside className="sticky top-0 hidden h-dvh w-[208px] shrink-0 self-start border-r border-sidebar-line bg-sidebar md:block">
      <div className="flex h-full flex-col overflow-y-auto px-2 py-2.5">
        <div className="mb-2.5">
          <BrandPicker brands={brands} current={current} />
        </div>
        <nav className="flex flex-1 flex-col gap-px" aria-label={`${current.name} email`}>
          {SECTIONS.map((s) => (
            <Link key={s.path} href={`/email/${current.id}${s.path}`} aria-current={section === s.path ? "page" : undefined} className={cx(ITEM, section === s.path && "bg-selected hover:bg-selected")}>
              <span className={ICON}>
                <Icon icon={s.icon} />
              </span>
              <span className="flex-1 truncate">{s.label}</span>
            </Link>
          ))}
        </nav>
        <div className="mt-2 flex flex-col gap-px border-t border-sidebar-line pt-2">
          <a href="https://selfhostlayer.com/docs/email" target="_blank" rel="noreferrer" className={cx(ITEM, "text-muted")}>
            <span className={ICON}>
              <Icon icon={BookTextIcon} />
            </span>
            <span className="flex-1 truncate">Docs</span>
          </a>
          <Link href={manage} className={cx(ITEM, "text-muted")} title="Manage Email: its deployments, logs, backups and updates">
            <span className={ICON}>
              <Icon icon={PuzzleIcon} />
            </span>
            <span className="flex-1 truncate">Email</span>
            {version && <span className="font-mono text-[11px] text-dim">{version}</span>}
          </Link>
        </div>
      </div>
    </aside>
  );
}

/** Phones: the picker and the pages as a row of tabs, above the page. */
export function EmailBar({ brands, current }: { brands: NavBrand[]; current: NavBrand }) {
  const section = useSection(current.id);
  return (
    <div className="grid gap-2 md:hidden">
      <div className="border border-border bg-card">
        <BrandPicker brands={brands} current={current} wide />
      </div>
      <nav className="flex gap-0.5 overflow-x-auto border border-border bg-field p-[3px]" aria-label={`${current.name} email`}>
        {SECTIONS.map((s) => (
          <Link key={s.path} href={`/email/${current.id}${s.path}`} aria-current={section === s.path ? "page" : undefined} className={cx("whitespace-nowrap px-[13px] py-[5px] transition-colors duration-150", section === s.path ? "bg-raised text-foreground shadow-raise" : "text-muted hover:text-foreground")}>
            {s.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

