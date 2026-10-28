import { redirect } from "next/navigation";
import { getInstallation } from "@/lib/github";
import { getApp, upsertInstallation } from "@/lib/github-store";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GitHub's setup URL: the browser lands here after installing (or changing)
 * the app. The installation is looked up with the app's own JWT, so an
 * installation id that isn't ours simply 404s.
 */
export async function GET(request: Request) {
  await requireUser();
  const app = getApp();
  if (!app) redirect("/github/connect");
  const id = Number(new URL(request.url).searchParams.get("installation_id"));
  if (!Number.isSafeInteger(id) || id <= 0) redirect("/new?error=installation");
  try {
    upsertInstallation(await getInstallation(app.credentials, id));
  } catch {
    redirect("/new?error=installation");
  }
  redirect("/new");
}
