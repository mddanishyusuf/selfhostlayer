import { allRepos, pageOf } from "@/lib/github-repos";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** A page of the repositories the GitHub App can see: ?q=<search>&offset=<n>&limit=<n> (10 by default). */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.mfaOk) return Response.json({ error: "Sign in again." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").slice(0, 100);
  const offset = Math.max(0, Math.floor(Number(params.get("offset")) || 0));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(params.get("limit")) || 10)));
  try {
    return Response.json(pageOf(await allRepos(), query, offset, limit));
  } catch {
    return Response.json({ error: "Couldn't load repositories from GitHub. Check that the app is still installed, then try again." }, { status: 502 });
  }
}
