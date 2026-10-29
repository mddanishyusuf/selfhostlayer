import { Bell, LogOut } from "lucide-react";
import Link from "next/link";
import { logout } from "@/app/actions/auth";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { Logo } from "@/components/ui";
import { listIncidents } from "@/lib/alerts/engine";
import { requireUser } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const openIncidents = listIncidents().filter((i) => !i.resolvedAt).length;
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" aria-label="Overview" className="shrink-0 rounded-md">
              <Logo withName={false} />
            </Link>
            <span className="text-border-strong" aria-hidden>
              /
            </span>
            <Breadcrumbs />
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/settings/alerts"
              title={openIncidents ? `${openIncidents} open incident${openIncidents === 1 ? "" : "s"}` : "Alerts"}
              className="relative grid size-8 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground"
            >
              <Bell className="size-4" aria-hidden />
              {openIncidents > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-err" aria-hidden />}
              <span className="sr-only">Alerts</span>
            </Link>
            <span className="hidden px-1 text-[13px] text-muted sm:inline">{user.email}</span>
            <form action={logout}>
              <button
                type="submit"
                title="Sign out"
                className="grid size-8 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground"
              >
                <LogOut className="size-4" aria-hidden />
                <span className="sr-only">Sign out</span>
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}
