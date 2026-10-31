import { NextResponse } from "next/server";
import { formsFetch, formsInstall } from "@/lib/forms";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** A form's responses as CSV, from Forms' admin API. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const project = formsInstall();
  if (!project) return NextResponse.json({ error: "Forms isn't installed" }, { status: 404 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: "no such form" }, { status: 404 });
  try {
    const res = await formsFetch(project, `forms/${id}/export`, { timeoutMs: 120_000 });
    return new NextResponse(res.body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="form-${id}-responses.csv"`, "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
