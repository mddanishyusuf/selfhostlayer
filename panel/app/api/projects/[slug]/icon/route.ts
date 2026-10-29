import { getProjectBySlug } from "@/lib/projects";
import { getSession } from "@/lib/session";
import { iconHost, siteIcon } from "@/lib/site-icon";

export const dynamic = "force-dynamic";

/** The favicon of a project's live domain, for its mark (only ever a project's own domain). */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return new Response("unauthorized", { status: 401 });
  const project = getProjectBySlug((await params).slug);
  const host = project ? iconHost(project.id) : null;
  const icon = host ? await siteIcon(host) : null;
  if (!icon) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(icon), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
}
