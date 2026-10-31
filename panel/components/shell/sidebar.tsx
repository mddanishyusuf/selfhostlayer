"use client";

import { ArrowUpRightIcon, BellIcon, BracesIcon, ChartColumnIcon, ChevronDownIcon, ChevronLeftIcon, CircleArrowUpIcon, ClockIcon, DatabaseBackupIcon, DatabaseIcon, FolderIcon, GlobeIcon, HistoryIcon, KeyRoundIcon, LayoutDashboardIcon, LinkIcon, LogOutIcon, MenuIcon, MoonIcon, PanelLeftOpenIcon, PuzzleIcon, RocketIcon, SearchIcon, ServerIcon, SettingsIcon, ShieldIcon, SquareTerminalIcon, SunIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { logout } from "@/app/actions/auth";
import { THEME_COOKIE, type Theme } from "@/lib/theme";
import { Icon, type IconSvgElement } from "../icon";
import { cx, LogoMark, StatusDot } from "../ui";
import { openPalette } from "./palette";
import { openUpdateModal } from "./update-modal";

export interface SidebarProject {
  slug: string;
  /** owner/name and the branch; an integration's name and version, "from the catalog". */
  repo: string;
  branch: string;
  /** Installed from Integrations: its pages go back there, and Projects doesn't count it. */
  integration: boolean;
  /** The catalog app (links), whose own pages come first. */
  app: string | null;
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
  /** A newer release, once a check found one. */
  update: { version: string } | null;
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
  const integrations = p.projects.filter((x) => x.integration).length;
  return [
    [
      { href: "/", label: "Projects", icon: FolderIcon, exact: true, count: p.projects.length - integrations },
      { href: "/deployments", label: "Deployments", icon: RocketIcon, dot: p.deploying },
      { href: "/analytics", label: "Analytics", icon: ChartColumnIcon },
      { href: "/firewall", label: "Firewall", icon: ShieldIcon },
      { href: "/domains", label: "Domains", icon: GlobeIcon, count: p.domainCount },
      { href: "/integrations", label: "Integrations", icon: PuzzleIcon, ...(integrations ? { count: integrations } : {}) },
      { href: "/databases", label: "Databases", icon: DatabaseIcon },
    ],
    [
      { href: "/health", label: "Health", icon: ServerIcon },
      { href: "/settings/backups", label: "Backups", icon: DatabaseBackupIcon },
      { href: "/settings/alerts", label: "Alerts", icon: BellIcon, dot: p.openIncidents > 0 },
      { href: "/settings/activity", label: "Activity", icon: HistoryIcon },
      { href: "/settings", label: "Settings", icon: SettingsIcon, exact: true },
    ],
  ];
}

/** An integration's own pages, above the ones every project has. */
function appNav(p: SidebarProject, base: string): Item[][] {
  if (p.app === "links") {
    return [
      [
        { href: `${base}/links`, label: "Links", icon: LinkIcon },
        { href: `${base}/stats`, label: "Stats", icon: ChartColumnIcon },
        { href: `${base}/api`, label: "API", icon: BracesIcon },
      ],
    ];
  }
  return [];
}

function projectNav(p: SidebarProject): Item[][] {
  const base = `/projects/${p.slug}`;
  return [
    ...appNav(p, base),
    [
      { href: base, label: "Overview", icon: LayoutDashboardIcon, exact: true },
      { href: `${base}/deployments`, label: "Deployments", icon: RocketIcon },
      { href: `${base}/logs`, label: "Logs", icon: SquareTerminalIcon },
      { href: `${base}/domains`, label: "Domains", icon: GlobeIcon },
      ...(p.isStatic
        ? []
        : [
            { href: `${base}/databases`, label: "Databases", icon: DatabaseIcon },
            { href: `${base}/backups`, label: "Backups", icon: DatabaseBackupIcon },
            { href: `${base}/crons`, label: "Cron jobs", icon: ClockIcon },
          ]),
      { href: `${base}/env`, label: "Environment", icon: KeyRoundIcon },
      { href: `${base}/settings`, label: "Settings", icon: SettingsIcon },
    ],
    p.url ? [{ href: p.url, label: "Visit site", icon: ArrowUpRightIcon, external: true }] : [],
  ];
}

function active(item: Item, pathname: string): boolean {
  if (item.external) return false;
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

// AgentOS's sidebar: rows with a 15px icon at three-quarter strength, the current
// one a lighter fill, counts as small badges, the footer under a line.
const ITEM = "flex w-full cursor-pointer select-none items-center gap-[9px] px-[9px] py-1.5 text-left text-foreground transition-colors duration-150 hover:bg-card";
const ICON = "grid w-[15px] shrink-0 place-items-center opacity-75";
const BADGE = "ml-auto inline-grid h-[17px] min-w-[19px] place-items-center bg-badge px-1.5 text-[10px] font-bold text-badge-text";

/** "Light mode" in the dark theme and "Dark mode" in the light one, as in AgentOS. */
function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState(initial);
  const [systemDark, setSystemDark] = useState(true);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const pick = (t: Theme) => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    document.cookie = `${THEME_COOKIE}=${t}; path=/; max-age=31536000; samesite=lax`;
  };
  return (
    <button type="button" onClick={() => pick(dark ? "light" : "dark")} className={ITEM}>
      <span className={ICON}>
        <Icon icon={dark ? SunIcon : MoonIcon} />
      </span>
      <span className="flex-1">{dark ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}

function NavItem({ item, on, onNavigate }: { item: Item; on: boolean; onNavigate?: () => void }) {
  const inner = (
    <>
      <span className={ICON}>
        <Icon icon={item.icon} />
      </span>
      <span className="flex-1 truncate">{item.label}</span>
      {item.count !== undefined && <span className={BADGE}>{item.count}</span>}
      {item.dot && <span className="ml-auto size-2 bg-warn-dot" aria-label="needs attention" />}
    </>
  );
  return item.external ? (
    <a href={item.href} target="_blank" rel="noreferrer" className={ITEM}>
      {inner}
    </a>
  ) : (
    <Link href={item.href} onClick={onNavigate} aria-current={on ? "page" : undefined} className={cx(ITEM, on && "bg-selected hover:bg-selected")}>
      {inner}
    </Link>
  );
}

function Nav(props: SidebarProps & { onNavigate?: () => void }) {
  const pathname = usePathname();
  const slug = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
  const project = props.projects.find((p) => p.slug === slug);
  // One list, as in AgentOS; the server's Settings sit in the footer.
  const items = (project ? projectNav(project) : globalNav(props)).flat().filter((i) => i.href !== "/settings");
  const settings: Item = { href: "/settings", label: "Settings", icon: SettingsIcon, exact: true };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-sidebar px-2 py-2.5">
      <Link href="/health" onClick={props.onNavigate} title={`${props.server.spec} · server health`} className="mb-2.5 flex items-center gap-2 p-2 transition-colors duration-150 hover:bg-card">
        <LogoMark size={17} className="size-7 bg-icon-tile text-icon-tile-fg" />
        <b className="min-w-0 flex-1 truncate font-bold">{props.server.name}</b>
        <span className="text-muted">
          <Icon icon={ChevronDownIcon} size={13} />
        </span>
      </Link>

      <button
        type="button"
        onClick={() => {
          props.onNavigate?.();
          openPalette();
        }}
        className={cx(ITEM, "mb-1 text-muted")}
      >
        <span className={ICON}>
          <Icon icon={SearchIcon} />
        </span>
        <span className="flex-1">Search</span>
        <kbd className="font-mono text-[11px] text-dim">⌘K</kbd>
      </button>

      {project && (
        <>
          <Link href={project.integration ? "/integrations" : "/"} onClick={props.onNavigate} className={cx(ITEM, "text-muted")}>
            <span className={ICON}>
              <Icon icon={ChevronLeftIcon} />
            </span>
            {project.integration ? "Integrations" : "All projects"}
          </Link>
          <div className="my-1.5 flex items-center gap-2 px-[9px] py-1.5" title={`${project.repo} · ${project.branch}`}>
            <StatusDot status={project.status} pulse={project.status === "warn"} />
            <b className="min-w-0 flex-1 truncate font-bold">{project.slug}</b>
          </div>
        </>
      )}

      <nav className="flex flex-1 flex-col gap-px" aria-label={project ? `${project.slug} navigation` : "Main navigation"}>
        {items.map((item) => (
          <NavItem key={item.href} item={item} on={active(item, pathname)} onNavigate={props.onNavigate} />
        ))}
      </nav>

      <div className="mt-2 flex flex-col gap-px border-t border-sidebar-line pt-2">
        {props.update && (
          <button
            type="button"
            onClick={() => {
              props.onNavigate?.();
              openUpdateModal();
            }}
            data-testid="sidebar-update"
            className={ITEM}
          >
            <span className={cx(ICON, "text-accent opacity-100")}>
              <Icon icon={CircleArrowUpIcon} />
            </span>
            <span className="flex-1 font-bold">Update</span>
            <span className={cx(BADGE, "font-mono font-normal")}>{props.update.version}</span>
          </button>
        )}
        <ThemeToggle initial={props.theme} />
        <NavItem item={settings} on={active(settings, pathname)} onNavigate={props.onNavigate} />
        <div className="flex items-center gap-[9px] px-[9px] py-1.5">
          <span className="grid size-[18px] shrink-0 place-items-center bg-icon-tile text-[11px] font-black uppercase text-icon-tile-fg" aria-hidden>
            {props.email.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted" title={props.server.host}>
            {props.email}
          </span>
          <form action={logout}>
            <button type="submit" title="Sign out" className="grid size-6 place-items-center text-muted transition-colors hover:bg-card hover:text-foreground">
              <Icon icon={LogOutIcon} size={14} />
              <span className="sr-only">Sign out</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/** Pages that need the width: the sidebar shrinks to its icons there. */
const COMPACT = /^\/projects\/[^/]+\/databases\/view/;

/**
 * The sidebar as a column of icons, each named on hover. The last button
 * opens the whole menu over the page, as on phones.
 */
function Rail(props: SidebarProps & { onExpand: () => void }) {
  const pathname = usePathname();
  const slug = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
  const project = props.projects.find((p) => p.slug === slug);
  const groups = project ? projectNav(project) : globalNav(props);
  const cls = (on: boolean) => cx("relative grid size-9 place-items-center transition-colors duration-150", on ? "bg-selected text-foreground" : "text-muted hover:bg-card hover:text-foreground");
  return (
    <div className="flex h-full flex-col items-center bg-sidebar py-2.5">
      <Link href="/" aria-label="Projects" title="Projects" className="grid size-9 shrink-0 place-items-center">
        <LogoMark size={17} className="size-7 bg-icon-tile text-icon-tile-fg" />
      </Link>
      <button type="button" onClick={openPalette} aria-label="Search" title="Search (⌘K)" className={cx(cls(false), "mt-3")}>
        <Icon icon={SearchIcon} size={16} />
      </button>
      {project && (
        <Link href="/" aria-label="All projects" title="All projects" className={cls(false)}>
          <Icon icon={ChevronLeftIcon} size={16} />
        </Link>
      )}
      <nav className="grid min-h-0 flex-1 content-start justify-items-center gap-0.5 overflow-y-auto py-2" aria-label={project ? `${project.slug} navigation` : "Main navigation"}>
        {groups.map((group, gi) =>
          group.length === 0 ? null : (
            <Fragment key={gi}>
              {gi > 0 && <div className="my-1.5 h-px w-6 bg-sidebar-line" />}
              {group.map((item) => {
                const on = active(item, pathname);
                const inner = (
                  <>
                    <Icon icon={item.icon} size={16} />
                    {item.dot && <span className="absolute right-1.5 top-1.5 size-2 bg-warn-dot" aria-label="needs attention" />}
                  </>
                );
                return item.external ? (
                  <a key={item.href} href={item.href} target="_blank" rel="noreferrer" aria-label={item.label} title={item.label} className={cls(false)}>
                    {inner}
                  </a>
                ) : (
                  <Link key={item.href} href={item.href} aria-label={item.label} title={item.label} aria-current={on ? "page" : undefined} className={cls(on)}>
                    {inner}
                  </Link>
                );
              })}
            </Fragment>
          ),
        )}
      </nav>
      {props.update && (
        <button type="button" onClick={openUpdateModal} aria-label={`Update to ${props.update.version}`} title={`Update available: ${props.update.version}`} className={cls(false)}>
          <Icon icon={CircleArrowUpIcon} size={16} className="text-accent" />
        </button>
      )}
      <button type="button" onClick={props.onExpand} aria-label="Open the menu" title="Open the menu" className={cx(cls(false), "mb-3")}>
        <Icon icon={PanelLeftOpenIcon} size={16} />
      </button>
    </div>
  );
}

/** Fixed to the left edge on desktop (icons only where pages need the width); a top bar with a drawer on phones. */
export function Sidebar(props: SidebarProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const compact = COMPACT.test(pathname);
  useEffect(() => setOpen(false), [pathname]);
  return (
    <>
      <aside className={cx("sticky top-0 hidden h-dvh shrink-0 border-r border-sidebar-line transition-[width] duration-150 ease-out md:block", compact ? "w-[56px]" : "w-[208px]")}>
        {compact ? <Rail {...props} onExpand={() => setOpen(true)} /> : <Nav {...props} />}
      </aside>

      <div className="fixed inset-x-0 top-0 z-20 flex h-14 items-center justify-between border-b border-sidebar-line bg-sidebar px-2.5 md:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="grid size-10 place-items-center hover:bg-card">
          <Icon icon={MenuIcon} size={20} />
        </button>
        <Link href="/" aria-label="Projects" className="rounded-lg">
          <LogoMark />
        </Link>
        <button type="button" onClick={openPalette} aria-label="Search" className="grid size-10 place-items-center hover:bg-card">
          <Icon icon={SearchIcon} size={20} />
        </button>
      </div>
      {open && (
        <div className={cx("fixed inset-0 z-40", !compact && "md:hidden")} role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[240px] border-r border-sidebar-line">
            <Nav {...props} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
