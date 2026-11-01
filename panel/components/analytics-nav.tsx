"use client";

// Analytics' own sidebar, beside the panel's (shrunk to its icons): the site
// picker at the top, then the site's pages. On phones it's a picker and a row
// of tabs above the page. The range chosen on one page carries to the next.
import { ActivityIcon, CheckIcon, ChevronsUpDownIcon, CircleDollarSignIcon, FileTextIcon, GlobeIcon, LayoutDashboardIcon, LayoutGridIcon, PlusIcon, PuzzleIcon, SettingsIcon, SquareArrowOutUpRightIcon, TargetIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { AddSiteDialog } from "./analytics-forms";
import { Icon, type IconSvgElement } from "./icon";
import { Dropdown, MENU_ITEM } from "./menu";
import { cx } from "./ui";

export interface NavSite {
  domain: string;
  visitors: number;
  live: number;
}

const SECTIONS: { path: string; label: string; icon: IconSvgElement }[] = [
  { path: "", label: "Overview", icon: LayoutDashboardIcon },
  { path: "/realtime", label: "Realtime", icon: ActivityIcon },
  { path: "/pages", label: "Pages", icon: FileTextIcon },
  { path: "/users", label: "Users", icon: UsersIcon },
  { path: "/goals", label: "Goals", icon: TargetIcon },
  { path: "/revenue", label: "Revenue", icon: CircleDollarSignIcon },
  { path: "/outbound", label: "Outbound", icon: SquareArrowOutUpRightIcon },
  { path: "/settings", label: "Settings", icon: SettingsIcon },
];

// As the panel's sidebar (components/shell/sidebar.tsx).
const ITEM = "flex w-full cursor-pointer select-none items-center gap-[9px] px-[9px] py-1.5 text-left text-foreground transition-colors duration-150 hover:bg-card";
const ICON = "grid w-[15px] shrink-0 place-items-center opacity-75";
/** The sidebar's count badge, with a green dot before the number: who's on the site now. */
const LIVE = "ml-auto inline-flex h-[17px] items-center gap-1 bg-badge px-1.5 text-[10px] font-bold tabular-nums text-badge-text";

/** Where we are: the section after /analytics/<domain>, and the range to keep. */
function useHere(domain: string) {
  const pathname = usePathname();
  const search = useSearchParams();
  const base = `/analytics/${domain}`;
  const section = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  const range = search.get("range");
  const keep = range ? `?range=${encodeURIComponent(range)}` : "";
  return { section: SECTIONS.some((s) => s.path === section) ? section : "", keep };
}

function SitePicker({ sites, current, suggestions, wide }: { sites: NavSite[]; current: string; suggestions: string[]; wide?: boolean }) {
  const router = useRouter();
  const { section, keep } = useHere(current);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Dropdown
        label="Pick a site"
        align="left"
        width={wide ? 260 : 220}
        buttonClassName="flex w-full items-center gap-2 p-2 text-left transition-colors duration-150 hover:bg-card"
        trigger={
          <>
            <span className="grid size-7 shrink-0 place-items-center bg-icon-tile text-icon-tile-fg">
              <Icon icon={GlobeIcon} size={15} />
            </span>
            <span className="grid min-w-0 flex-1 leading-tight">
              <b className="truncate font-bold" data-testid="site-picker">
                {current}
              </b>
              <span className="truncate text-[11.5px] text-muted">Analytics</span>
            </span>
            <span className="text-muted">
              <Icon icon={ChevronsUpDownIcon} size={14} />
            </span>
          </>
        }
      >
        {(close) => (
          <>
            {sites.map((s) => (
              <button
                key={s.domain}
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  router.push(`/analytics/${s.domain}${section}${keep}`);
                }}
              >
                <span className="grid w-4 shrink-0 place-items-center">{s.domain === current && <Icon icon={CheckIcon} size={14} />}</span>
                <span className="min-w-0 flex-1 truncate">{s.domain}</span>
                {s.live > 0 && <span className="size-1.5 bg-ok-dot" title={`${s.live} on the site now`} aria-label={`${s.live} on the site now`} />}
                <span className="text-[12px] tabular-nums text-dim" title="Visitors in the last 24 hours">
                  {s.visitors.toLocaleString("en")}
                </span>
              </button>
            ))}
            <div className="my-1 h-px bg-border" />
            <Link href="/analytics" role="menuitem" className={MENU_ITEM} onClick={close} data-testid="all-sites">
              <span className="grid w-4 shrink-0 place-items-center">
                <Icon icon={LayoutGridIcon} size={14} />
              </span>
              All sites
            </Link>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                close();
                setAdding(true);
              }}
              data-testid="new-site"
            >
              <span className="grid w-4 shrink-0 place-items-center">
                <Icon icon={PlusIcon} size={14} />
              </span>
              Add a site
            </button>
          </>
        )}
      </Dropdown>
      {adding && <AddSiteDialog suggestions={suggestions} onClose={() => setAdding(false)} />}
    </>
  );
}

/** The 208px column beside the panel's icons, from 768px up. */
export function AnalyticsNav({ sites, current, live, suggestions, manage, version }: { sites: NavSite[]; current: string; live: number; suggestions: string[]; manage: string; version: string | null }) {
  const { section, keep } = useHere(current);
  return (
    <aside className="sticky top-0 hidden h-dvh w-[208px] shrink-0 self-start border-r border-sidebar-line bg-sidebar md:block">
      <div className="flex h-full flex-col overflow-y-auto px-2 py-2.5">
        <div className="mb-2.5">
          <SitePicker sites={sites} current={current} suggestions={suggestions} />
        </div>
        <nav className="flex flex-1 flex-col gap-px" aria-label={`${current} analytics`}>
          {SECTIONS.map((s) => {
            const on = section === s.path;
            return (
              <Link key={s.path} href={`/analytics/${current}${s.path}${keep}`} aria-current={on ? "page" : undefined} className={cx(ITEM, on && "bg-selected hover:bg-selected")}>
                <span className={ICON}>
                  <Icon icon={s.icon} />
                </span>
                <span className="flex-1 truncate">{s.label}</span>
                {s.path === "/realtime" && live > 0 && (
                  <span className={LIVE} title={`${live} on the site now`}>
                    <span className="size-1.5 bg-ok-dot" aria-hidden />
                    {live}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="mt-2 flex flex-col gap-px border-t border-sidebar-line pt-2">
          <Link href={manage} className={cx(ITEM, "text-muted")} title="Manage Analytics: its deployments, logs, backups and updates">
            <span className={ICON}>
              <Icon icon={PuzzleIcon} />
            </span>
            <span className="flex-1 truncate">Analytics</span>
            {version && <span className="font-mono text-[11px] text-dim">{version}</span>}
          </Link>
        </div>
      </div>
    </aside>
  );
}

/** Phones: the picker and the pages as a row of tabs, above the page. */
export function AnalyticsBar({ sites, current, suggestions }: { sites: NavSite[]; current: string; suggestions: string[] }) {
  const { section, keep } = useHere(current);
  return (
    <div className="grid gap-2 md:hidden">
      <div className="border border-border bg-card">
        <SitePicker sites={sites} current={current} suggestions={suggestions} wide />
      </div>
      <nav className="flex gap-0.5 overflow-x-auto border border-border bg-field p-[3px]" aria-label={`${current} analytics`}>
        {SECTIONS.map((s) => (
          <Link
            key={s.path}
            href={`/analytics/${current}${s.path}${keep}`}
            aria-current={section === s.path ? "page" : undefined}
            className={cx("whitespace-nowrap px-[13px] py-[5px] transition-colors duration-150", section === s.path ? "bg-raised text-foreground shadow-raise" : "text-muted hover:text-foreground")}
          >
            {s.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
