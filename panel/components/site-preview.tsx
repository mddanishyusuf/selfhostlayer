import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { sitePreview } from "@/lib/preview";
import { Icon } from "./icon";
import { Mark, Skeleton, cx } from "./ui";

/** A small browser window: an address bar, then the page at link-preview proportions (1200×630). */
function Frame({ host, href, children }: { host: string; href?: string; children: ReactNode }) {
  const body = (
    <>
      <div className="flex h-8 items-center gap-1.5 border-b border-border bg-sidebar px-3">
        <span className="size-2 rounded-full bg-border-strong" />
        <span className="size-2 rounded-full bg-border-strong" />
        <span className="size-2 rounded-full bg-border-strong" />
        <span className="ml-2 min-w-0 flex-1 truncate text-[12px] text-dim">{host}</span>
        {href && <Icon icon={ArrowUpRight01Icon} size={13} className="text-dim transition-colors duration-150 group-hover:text-foreground" />}
      </div>
      <div className="relative aspect-[1200/630] overflow-hidden bg-hover">{children}</div>
    </>
  );
  const cls = "group block overflow-hidden rounded-lg border border-border transition-colors duration-150";
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${host}`} className={cx(cls, "hover:border-border-strong")}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const Card = ({ slug, index, title, text }: { slug: string; index: number; title: ReactNode; text?: ReactNode }) => (
  <div className="absolute inset-0 grid place-content-center justify-items-center gap-2 px-8 text-center">
    <Mark name={slug} index={index} />
    <p className="text-[15px] font-semibold">{title}</p>
    {text && <p className="line-clamp-2 max-w-[340px] text-[12.5px] text-muted">{text}</p>}
  </div>
);

export function SitePreviewSkeleton({ host }: { host: string }) {
  return (
    <Frame host={host}>
      <Skeleton className="absolute inset-0 rounded-none" />
    </Frame>
  );
}

/** The live site's link-preview image, or a card with its title when it has none. Taken once per deployment (lib/preview). */
export async function SitePreviewFrame({ slug, index, deploymentId, url, own }: { slug: string; index: number; deploymentId: number | null; url: string; own: string[] }) {
  const host = new URL(url).host;
  if (deploymentId === null) {
    return (
      <Frame host={host}>
        <Card slug={slug} index={index} title="Not live yet" text="The preview appears after the first deploy." />
      </Frame>
    );
  }
  const preview = await sitePreview(slug, deploymentId, url, own).catch(() => null);
  return (
    <Frame host={host} href={url}>
      {preview?.image ? (
        <img src={`/api/projects/${slug}/preview?v=${deploymentId}`} alt={`${preview.title ?? slug} preview`} className="absolute inset-0 size-full object-cover" />
      ) : (
        <Card slug={slug} index={index} title={preview?.title ?? slug} text={preview?.description ?? (preview?.error ? "No preview: the site couldn't be reached from the server." : "The site has no preview image (og:image).")} />
      )}
    </Frame>
  );
}
