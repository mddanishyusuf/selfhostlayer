"use client";

import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Blocks,
  ChartColumn,
  Clock,
  Database,
  DatabaseBackup,
  Globe,
  LayoutGrid,
  LogOut,
  Menu,
  Plus,
  Rocket,
  Settings,
  Shield,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { logout } from "@/app/actions/auth";
import { Logo, StatusDot, cx } from "../ui";

export interface SidebarProject {
  slug: string;
  repo: string;
  status: "ok" | "warn" | "err" | "idle";
  isStatic: boolean;
  url: string | null;
}

interface Item {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Active on this exact path only (otherwise also on sub-paths). */
  exact?: boolean;
  dot?: boolean;
  external?: boolean;
}

function globalItems(openIncidents: number): Item[][] {
  return [
    [
      { href: "/", label: "Projects", icon: LayoutGrid, exact: true },
      { href: "/deployments", label: "Deployments", icon: Rocket },
      { href: "/analytics", label: "Analytics", icon: ChartColumn },
      { href: "/firewall", label: "Firewall", icon: Shield },
      { href: "/domains", label: "Domains", icon: Globe },
      { href: "/integrations", label: "Integrations", icon: Blocks },
      { href: "/databases", label: "Databases", icon: Database },
    ],
    [
      { href: "/settings/backups", label: "Backups", icon: DatabaseBackup },
      { href: "/settings/alerts", label: "Alerts", icon: Bell, dot: openIncidents > 0 },
    ],
  ];
}

function projectItems(p: SidebarProject): Item[][] {
  const base = `/projects/${p.slug}`;
  return [
    [
      { href: base, label: "Overview", icon: LayoutGrid, exact: true },
      { href: `${base}/deployments`, label: "Deployments", icon: Rocket },
      { href: `${base}/domains`, label: "Domains", icon: Globe },
      ...(p.isStatic
        ? []
        : [
            { href: `${base}/databases`, label: "Databases", icon: Database },
            { href: `${base}/backups`, label: "Backups", icon: DatabaseBackup },
          ]),
      { href: `${base}/crons`, label: "Cron jobs", icon: Clock },
      { href: `${base}/settings`, label: "Settings", icon: Settings },
    ],
    p.url ? [{ href: p.url, label: "Visit site", icon: ArrowUpRight, external: true }] : [],
  ];
}

function NavItem({ item, active, onNavigate }: { item: Item; active: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  const inner = (
    <span
      className={cx(
        "inline-flex items-center gap-4 rounded-full py-2.5 pl-3 pr-3 text-[16px] transition-colors duration-150 group-hover:bg-hover md:max-lg:pr-3 lg:pr-5",
        active ? "font-bold" : "font-normal",
      )}
    >
      <span className="relative">
        <Icon className="size-[22px]" strokeWidth={active ? 2.6 : 1.9} aria-hidden />
        {item.dot && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent ring-2 ring-background" aria-label="open incidents" />}
      </span>
      <span className="md:max-lg:sr-only">{item.label}</span>
    </span>
  );
  const props = { title: item.label, className: "group flex outline-none focus-visible:[&>span]:ring-2 focus-visible:[&>span]:ring-accent/50 md:max-lg:justify-center", onClick: onNavigate };
  return item.external ? (
    <a href={item.href} target="_blank" rel="noreferrer" {...props}>
      {inner}
    </a>
  ) : (
    <Link href={item.href} aria-current={active ? "page" : undefined} {...props}>
      {inner}
    </Link>
  );
}

function isActive(item: Item, pathname: string): boolean {
  if (item.external) return false;
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function Nav({ projects, openIncidents, email, server, onNavigate }: SidebarProps & { onNavigate?: () => void }) {
  const pathname = usePathname();
  const slug = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
  const project = projects.find((p) => p.slug === slug);
  const groups = project ? projectItems(project) : globalItems(openIncidents);

  return (
    <div className="flex h-full flex-col gap-1 px-2 py-2 lg:px-3">
      <Link href="/" onClick={onNavigate} aria-label="Self Host Layer" className="mb-1 inline-flex w-fit rounded-full p-2.5 transition-colors duration-150 hover:bg-hover md:max-lg:self-center">
        <Logo withName={false} />
      </Link>

      {project && (
        <div className="mb-2 grid gap-2 md:max-lg:justify-items-center">
          <Link href="/" onClick={onNavigate} title="All projects" className="inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-[13px] text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
            <ArrowLeft className="size-4" aria-hidden /> <span className="md:max-lg:sr-only">All projects</span>
          </Link>
          <div className="grid gap-0.5 px-3 md:max-lg:hidden">
            <p className="flex items-center gap-2 truncate text-[17px] font-bold">
              <StatusDot status={project.status} /> {project.slug}
            </p>
            <p className="truncate text-[13px] text-muted">{project.repo}</p>
          </div>
        </div>
      )}

      <nav className="grid gap-0.5" aria-label={project ? `${project.slug} navigation` : "Main navigation"}>
        {groups.map((group, i) => (
          <div key={i} className={cx("grid gap-0.5", i > 0 && group.length > 0 && "mt-2 border-t border-border pt-2")}>
            {group.map((item) => (
              <NavItem key={item.href} item={item} active={isActive(item, pathname)} onNavigate={onNavigate} />
            ))}
          </div>
        ))}
      </nav>

      {!project && (
        <Link
          href="/new"
          onClick={onNavigate}
          className="mt-4 inline-flex h-[50px] items-center justify-center gap-2 rounded-full bg-inverse text-[16px] font-bold text-inverse-fg transition-opacity duration-150 hover:opacity-90 md:max-lg:size-[50px] md:max-lg:self-center lg:w-full"
          title="New project"
        >
          <Plus className="size-5 lg:hidden" aria-hidden />
          <span className="md:max-lg:sr-only">New project</span>
        </Link>
      )}

      <div className="mt-auto flex items-center gap-3 rounded-full p-2 md:max-lg:justify-center">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-subtle text-[15px] font-bold uppercase" aria-hidden>
          {email.slice(0, 1)}
        </span>
        <div className="grid min-w-0 flex-1 md:max-lg:hidden">
          <p className="truncate text-[14px] font-bold">{email}</p>
          <p className="flex items-center gap-1.5 truncate text-[13px] text-muted">
            <SquareTerminal className="size-3.5 shrink-0" aria-hidden /> {server}
          </p>
        </div>
        <form action={logout} className="md:max-lg:hidden">
          <button type="submit" title="Sign out" className="grid size-9 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
            <LogOut className="size-[18px]" aria-hidden />
            <span className="sr-only">Sign out</span>
          </button>
        </form>
      </div>
    </div>
  );
}

export interface SidebarProps {
  projects: SidebarProject[];
  openIncidents: number;
  email: string;
  server: string;
}

/** Left column on md and up; on phones a top bar with a drawer. */
export function Sidebar(props: SidebarProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <>
      <aside className="sticky top-0 hidden h-dvh shrink-0 md:block md:w-[88px] lg:w-[275px]">
        <Nav {...props} />
      </aside>

      <div className="fixed inset-x-0 top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background/85 px-2 backdrop-blur-md md:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="grid size-10 place-items-center rounded-full hover:bg-hover">
          <Menu className="size-5" aria-hidden />
        </button>
        <Link href="/" aria-label="Self Host Layer">
          <Logo withName={false} />
        </Link>
        <span className="size-10" aria-hidden />
      </div>
      {open && (
        <div className="fixed inset-0 z-30 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[280px] border-r border-border bg-background shadow-xl">
            <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="absolute right-2 top-3 grid size-9 place-items-center rounded-full hover:bg-hover">
              <X className="size-5" aria-hidden />
            </button>
            <Nav {...props} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
