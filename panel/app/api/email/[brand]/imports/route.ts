import { NextResponse } from "next/server";
import { emailApi, EmailError, emailInstall, type ImportJob } from "@/lib/email";
import { panelOrigin } from "@/lib/origin";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * A contacts CSV for an import (up to 1 GB): its body streamed to Email as is,
 * ?name= its file name. Email keeps it on disk and answers with the job, its
 * headers and a few rows, for the column mapping.
 */
export async function POST(req: Request, { params }: { params: Promise<{ brand: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  // The session cookie is SameSite=Lax already; this refuses a post from another site outright.
  if (req.headers.get("origin") !== (await panelOrigin())) return NextResponse.json({ error: "This request didn't come from the panel." }, { status: 403 });
  const project = emailInstall();
  if (!project) return NextResponse.json({ error: "Email isn't installed." }, { status: 404 });
  if (!req.body) return NextResponse.json({ error: "Choose a CSV file." }, { status: 400 });
  const brand = Number((await params).brand);
  const name = new URL(req.url).searchParams.get("name") ?? "contacts.csv";
  try {
    const job = await emailApi<ImportJob>(project, `brands/${brand}/imports?name=${encodeURIComponent(name)}`, { stream: req.body, timeoutMs: 30 * 60_000 });
    return NextResponse.json(job);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: err instanceof EmailError ? err.status : 502 });
  }
}
