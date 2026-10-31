import { NextResponse } from "next/server";
import { formsFetch, formsInstall } from "@/lib/forms";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** A file someone sent with a response, from Forms' admin API: always a download, never shown inline. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const project = formsInstall();
  if (!project) return NextResponse.json({ error: "Forms isn't installed" }, { status: 404 });
  const { id, file } = await params;
  if (!/^\d{1,9}$/.test(id) || !/^[0-9a-f]{24}$/.test(file)) return NextResponse.json({ error: "no such file" }, { status: 404 });
  try {
    const res = await formsFetch(project, `forms/${id}/files/${file}`, { timeoutMs: 120_000 });
    return new NextResponse(res.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": res.headers.get("content-disposition") ?? "attachment",
        ...(res.headers.get("content-length") ? { "Content-Length": res.headers.get("content-length")! } : {}),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: (err as { status?: number }).status === 404 ? 404 : 502 });
  }
}
