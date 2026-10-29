import { CornerDownRight, Globe } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader, RowList } from "@/components/page";
import { StatusDot } from "@/components/ui";
import { listAllDomains } from "@/lib/domains";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Domains" };

const ROLE = { free: "Free URL", primary: "Custom", redirect: "Redirect" } as const;

export default async function AllDomainsPage() {
  await requireUser();
  const domains = listAllDomains();
  return (
    <>
      <PageHeader title="Domains" subtitle="Every project's domains. Add one from the project's Domains page." />
      <PageBody>
        <RowList>
          {domains.length === 0 && <p className="px-5 py-10 text-center text-muted">No domains yet.</p>}
          {domains.map((d) => (
            <div key={d.id} className="relative flex items-center gap-4 px-4 py-3.5 transition-colors duration-150 hover:bg-subtle sm:px-5">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-subtle text-muted">
                {d.role === "redirect" ? <CornerDownRight className="size-4" aria-hidden /> : <Globe className="size-4" aria-hidden />}
              </span>
              <div className="grid min-w-0 flex-1 gap-0.5">
                <Link href={`/projects/${d.slug}/domains`} className="truncate text-[15px] font-bold after:absolute after:inset-0">
                  {d.host}
                </Link>
                <p className="truncate text-[13px] text-muted">
                  <span className="font-bold text-foreground">{d.slug}</span> · {ROLE[d.role]}
                  {d.redirectTo && ` → ${d.redirectTo}`}
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-2 text-[13px] font-medium">
                <StatusDot status={d.status === "active" ? "ok" : "warn"} /> {d.status === "active" ? "Live" : "Waiting for DNS"}
              </span>
            </div>
          ))}
        </RowList>
      </PageBody>
    </>
  );
}
