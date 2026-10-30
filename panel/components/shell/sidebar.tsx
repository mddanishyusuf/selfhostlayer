"use client";

import {
  Analytics01Icon,
  ArrowLeft01Icon,
  ArrowUpRight01Icon,
  Clock01Icon,
  CommandLineIcon,
  ComputerIcon,
  DashboardSquare01Icon,
  Database01Icon,
  DatabaseRestoreIcon,
  FolderLibraryIcon,
  Globe02Icon,
  Key01Icon,
  Logout01Icon,
  Menu01Icon,
  Moon02Icon,
  Notification01Icon,
  WorkHistoryIcon,
  PuzzleIcon,
  Rocket01Icon,
  Search01Icon,
  Settings01Icon,
  Shield01Icon,
  Sun03Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { logout } from "@/app/actions/auth";
import { THEME_COOKIE, type Theme } from "@/lib/theme";
import { Icon, type IconSvgElement } from "../icon";
import { cx, LogoMark, StatusDot } from "../ui";
import { openPalette } from "./palette";
import { openServerModal } from "./server-modal";

export interface SidebarProject {
  slug: string;
  repo: string;
  branch: string;
  status: "ok" | "warn" | "err" | "idle";
  isStatic: boolean;
  url: string | null;
}

export interface SidebarProps {
  projects: SidebarProject[];
  domainCount: number;
  deploying: boolean;
  openIncidents: number;
  email: string;
  server: { name: string; spec: string; host: string };
  theme: Theme;
}

interface Item {
  href: string;
  label: string;
  icon: IconSvgElement;
  exact?: boolean;
  count?: number;
  dot?: boolean;
  external?: boolean;
}

function globalNav(p: SidebarProps): Item[][] {
  return [
    [
      { href: "/", label: "Projects", icon: FolderLibraryIcon, exact: true, count: p.projects.length },
      { href: "/deployments", label: "Deployments", icon: Rocket01Icon, dot: p.deploying },
      { href: "/analytics", label: "Analytics", icon: Analytics01Icon },
      { href: "/firewall", label: "Firewall", icon: Shield01Icon },
      { href: "/domains", label: "Domains", icon: Globe02Icon, count: p.domainCount },
      { href: "/integrations", label: "Integrations", icon: PuzzleIcon },
      { href: "/databases", label: "Databases", icon: Database01Icon },
    ],
    [
      { href: "/settings/backups", label: "Backups", icon: DatabaseRestoreIcon },
      { href: "/settings/alerts", label: "Alerts", icon: Notification01Icon, dot: p.openIncidents > 0 },
      { href: "/settings/activity", label: "Activity", icon: WorkHistoryIcon },
      { href: "/settings", label: "Settings", icon: Settings01Icon, exact: true },
    ],
  ];
}

function projectNav(p: SidebarProject): Item[][] {
  const base = `/projects/${p.slug}`;
  return [
    [
      { href: base, label: "Overview", icon: DashboardSquare01Icon, exact: true },
      { href: `${base}/deployments`, label: "Deployments", icon: Rocket01Icon },
      { href: `${base}/logs`, label: "Logs", icon: CommandLineIcon },
      { href: `${base}/domains`, label: "Domains", icon: Globe02Icon },
      ...(p.isStatic
        ? []
        : [
            { href: `${base}/databases`, label: "Databases", icon: Database01Icon },
            { href: `${base}/backups`, label: "Backups", icon: DatabaseRestoreIcon },
            { href: `${base}/crons`, label: "Cron jobs", icon: Clock01Icon },
          ]),
      { href: `${base}/env`, label: "Environment", icon: Key01Icon },
      { href: `${base}/settings`, label: "Settings", icon: Settings01Icon },
    ],
    p.url ? [{ href: p.url, label: "Visit site", icon: ArrowUpRight01Icon, external: true }] : [],
  ];
}

function active(item: Item, pathname: string): boolean {
  if (item.external) return false;
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function ThemeSwitch({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState(initial);
  const pick = (t: Theme) => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    document.cookie = `${THEME_COOKIE}=${t}; path=/; max-age=31536000; samesite=lax`;
  };
  const options: [Theme, IconSvgElement, string][] = [
    ["dark", Moon02Icon, "Dark"],
    ["light", Sun03Icon, "Light"],
    ["system", ComputerIcon, "System"],
  ];
  return (
    <div className="flex gap-0.5 rounded-lg border border-border p-0.5" role="radiogroup" aria-label="Theme">
      {options.map(([t, icon, label]) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          title={label}
          onClick={() => pick(t)}
          className={cx("grid h-6 w-[26px] place-items-center rounded-md transition-colors", theme === t ? "bg-selected text-foreground" : "text-dim hover:text-foreground")}
        >
          <Icon icon={icon} size={14} />
        </button>
      ))}
    </div>
  );
}

function Nav(props: SidebarProps & { onNavigate?: () => void }) {
  const pathname = usePathname();
  const slug = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
  const project = props.projects.find((p) => p.slug === slug);
  const groups = project ? projectNav(project) : globalNav(props);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 border-b border-border px-4">
        <Link href="/" onClick={props.onNavigate} aria-label="Projects" className="shrink-0 rounded-lg">
          <LogoMark />
        </Link>
        <button type="button" onClick={openServerModal} title="Server status" className="grid min-w-0 flex-1 text-left leading-tight">
          <b className="truncate text-sm font-semibold">{props.server.name}</b>
          <span className="truncate text-[12px] text-muted">{props.server.spec}</span>
        </button>
        <span className="grid size-8 place-items-center text-dim" title="One server (multi-server comes later)">
          <Icon icon={UnfoldMoreIcon} size={16} />
        </span>
      </div>

      <button
        type="button"
        onClick={() => {
          props.onNavigate?.();
          openPalette();
        }}
        className="mx-3 mb-1 mt-3 flex h-9 items-center gap-2.5 rounded-md border border-border px-2.5 text-left text-dim transition-colors hover:border-border-strong hover:text-muted"
      >
        <Icon icon={Search01Icon} size={16} />
        <span>Search</span>
        <kbd className="ml-auto rounded-[5px] border border-border px-1.5 font-mono text-[11px] text-dim">⌘K</kbd>
      </button>

      {project && (
        <>
          <Link href="/" onClick={props.onNavigate} className="mt-1.5 flex h-10 items-center gap-2 border-y border-border px-5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-foreground">
            <Icon icon={ArrowLeft01Icon} size={15} /> All projects
          </Link>
          <div className="grid gap-1 border-b border-border px-5 py-4">
            <b className="flex items-center gap-2 text-base font-bold">
              <StatusDot status={project.status} pulse={project.status === "warn"} /> {project.slug}
            </b>
            <span className="truncate text-[12.5px] text-muted">
              {project.repo} · {project.branch}
            </span>
          </div>
        </>
      )}

      <nav className="flex-1 overflow-auto pb-3 pt-1.5" aria-label={project ? `${project.slug} navigation` : "Main navigation"}>
        {groups.map((group, gi) =>
          group.length === 0 ? null : (
            <div key={gi}>
              {gi > 0 && (project ? <div className="my-2 h-px bg-border" /> : <p className="px-5 pb-1.5 pt-[18px] text-[12px] font-medium text-dim">Server</p>)}
              {group.map((item) => {
                const on = active(item, pathname);
                const cls = cx(
                  "relative flex h-[38px] items-center gap-3 px-5 text-sm transition-colors duration-150",
                  on ? "bg-selected font-semibold text-foreground before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-foreground" : "text-muted hover:bg-hover hover:text-foreground",
                );
                const inner = (
                  <>
                    <Icon icon={item.icon} size={18} />
                    {item.label}
                    {item.count !== undefined && <span className="ml-auto text-[12px] tabular-nums text-dim">{item.count}</span>}
                    {item.dot && <span className="ml-auto size-[7px] rounded-full bg-gold" aria-label="needs attention" />}
                  </>
                );
                return item.external ? (
                  <a key={item.href} href={item.href} target="_blank" rel="noreferrer" className={cls}>
                    {inner}
                  </a>
                ) : (
                  <Link key={item.href} href={item.href} onClick={props.onNavigate} aria-current={on ? "page" : undefined} className={cls}>
                    {inner}
                  </Link>
                );
              })}
            </div>
          ),
        )}
      </nav>

      <div className="shrink-0 border-t border-border">
        <div className="flex items-center gap-2.5 px-4 py-2.5">
          <span className="flex-1 text-[12.5px] text-dim">Theme</span>
          <ThemeSwitch initial={props.theme} />
        </div>
        <div className="flex items-center gap-2.5 border-t border-border px-4 py-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-selected text-[13px] font-bold uppercase" aria-hidden>
            {props.email.slice(0, 1)}
          </span>
          <div className="grid min-w-0 flex-1 leading-tight">
            <b className="truncate text-[13px] font-semibold">{props.email}</b>
            <span className="truncate text-[12px] text-dim">{props.server.host}</span>
          </div>
          <form action={logout}>
            <button type="submit" title="Sign out" className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-foreground">
              <Icon icon={Logout01Icon} size={16} />
              <span className="sr-only">Sign out</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/** Fixed to the left edge on desktop; a top bar with a drawer on phones. */
export function Sidebar(props: SidebarProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-[252px] shrink-0 border-r border-border md:block">
        <Nav {...props} />
      </aside>

      <div className="fixed inset-x-0 top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background px-2.5 md:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="grid size-10 place-items-center rounded-lg hover:bg-hover">
          <Icon icon={Menu01Icon} size={20} />
        </button>
        <Link href="/" aria-label="Projects" className="rounded-lg">
          <LogoMark />
        </Link>
        <button type="button" onClick={openPalette} aria-label="Search" className="grid size-10 place-items-center rounded-lg hover:bg-hover">
          <Icon icon={Search01Icon} size={20} />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[280px] border-r border-border shadow-xl">
            <Nav {...props} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
