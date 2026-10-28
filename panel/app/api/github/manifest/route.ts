import { redirect } from "next/navigation";
import { convertManifest, GITHUB_WEB } from "@/lib/github";
import { consumeState, saveApp } from "@/lib/github-store";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** GitHub sends the browser back here after the user creates the app from our manifest. */
export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!consumeState(state, user.id)) redirect("/github/connect?error=state");
  let slug: string;
  try {
    const app = await convertManifest(code);
    saveApp(app);
    slug = app.slug;
  } catch {
    redirect("/github/connect?error=convert");
  }
  // Next: install the new app on the repos to deploy.
  redirect(`${GITHUB_WEB}/apps/${encodeURIComponent(slug)}/installations/new`);
}
