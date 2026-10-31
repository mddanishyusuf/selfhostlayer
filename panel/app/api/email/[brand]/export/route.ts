import { NextResponse } from "next/server";
import { emailApi, emailInstall } from "@/lib/email";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** A brand's contacts as CSV, from Email's admin API. */
export async function GET(req: Request, { params }: { params: Promise<{ brand: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const project = emailInstall();
  if (!project) return NextResponse.json({ error: "Email isn't installed" }, { status: 404 });
  const brand = Number((await params).brand);
  const q = new URL(req.url).searchParams;
  const p = new URLSearchParams();
  for (const k of ["list", "status"]) if (q.get(k)) p.set(k, q.get(k)!);
  try {
    const csv = await emailApi<string>(project, `brands/${brand}/export${p.size ? `?${p}` : ""}`, { raw: true, timeoutMs: 120_000 });
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="contacts-${brand}.csv"`, "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
