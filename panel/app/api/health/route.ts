export const dynamic = "force-dynamic";

/** For the installer and monitoring: the panel process answers. No details. */
export function GET() {
  return Response.json({ ok: true });
}
