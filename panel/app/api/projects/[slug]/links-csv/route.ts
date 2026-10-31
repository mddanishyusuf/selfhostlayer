import { isLinks, LinksError, linksApi } from "@/lib/links";
import { getProjectBySlug } from "@/lib/projects";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Every link of a Links install as CSV, from its admin API. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return new Response("unauthorized", { status: 401 });
  const project = getProjectBySlug((await params).slug);
  if (!project || !isLinks(project)) return new Response("not found", { status: 404 });
  try {
    const csv = await linksApi<string>(project, "export", { raw: true });
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${project.slug}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return new Response(err instanceof LinksError ? err.message : "Links didn't answer", { status: 502 });
  }
}
