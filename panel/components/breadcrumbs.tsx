"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";

/** The top bar's trail: Overview / piqo / Settings, from the URL. */
export function Breadcrumbs() {
  const parts = usePathname().split("/").filter(Boolean);
  const crumbs: { label: string; href?: string }[] = [];
  if (parts[0] === "projects" && parts[1]) {
    crumbs.push({ label: parts[1], href: parts[2] ? `/projects/${parts[1]}` : undefined });
    if (parts[2] === "settings") crumbs.push({ label: "Settings" });
    if (parts[2] === "domains") crumbs.push({ label: "Domains" });
    if (parts[2] === "crons") {
      crumbs.push({ label: "Crons", href: parts[3] ? `/projects/${parts[1]}/crons` : undefined });
      if (parts[3]) crumbs.push({ label: parts[3] });
    }
  } else if (parts[0] === "deployments" && parts[1]) {
    crumbs.push({ label: `Deployment #${parts[1]}` });
  } else if (parts[0] === "new") {
    crumbs.push({ label: "New project" });
  } else if (parts[0] === "github") {
    crumbs.push({ label: "GitHub" });
  }
  const all = [{ label: "Overview", href: crumbs.length ? "/" : undefined }, ...crumbs];
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-3">
      {all.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="text-border-strong" aria-hidden>
              /
            </span>
          )}
          {c.href ? (
            <Link href={c.href} className="truncate text-muted transition-colors duration-150 hover:text-foreground">
              {c.label}
            </Link>
          ) : (
            <span className="truncate font-medium" aria-current="page">
              {c.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
