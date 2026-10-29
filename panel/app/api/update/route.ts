import { agent } from "@/lib/agent";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The running update, for the page that follows it (the panel itself restarts midway). */
export async function GET() {
  const session = await getSession();
  if (!session?.mfaOk) return new Response("unauthorized", { status: 401 });
  try {
    return Response.json(await agent("update.status"));
  } catch {
    return Response.json({ error: "the agent is restarting" }, { status: 503 });
  }
}
