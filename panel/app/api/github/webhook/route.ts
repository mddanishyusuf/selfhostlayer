import { verifyWebhookSignature, type Installation } from "@/lib/github";
import { createDeployment } from "@/lib/deploy";
import { forgetRepos } from "@/lib/github-repos";
import { getApp, recordDelivery, removeInstallation, upsertInstallation } from "@/lib/github-store";
import { projectsForPush } from "@/lib/projects";

export const dynamic = "force-dynamic";

const MAX_BODY = 5 * 1024 * 1024;

/**
 * GitHub webhook deliveries. The only route without a session, so every
 * request must carry a valid X-Hub-Signature-256 for this server's app, and
 * each delivery id is processed once.
 */
export async function POST(request: Request) {
  const app = getApp();
  if (!app) return Response.json({ error: "no GitHub App connected" }, { status: 404 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "payload too large" }, { status: 413 });
  if (!verifyWebhookSignature(app.webhookSecret, raw, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  const event = request.headers.get("x-github-event") ?? "";
  const delivery = request.headers.get("x-github-delivery") ?? "";
  if (!/^[0-9a-f-]{8,64}$/i.test(delivery)) return Response.json({ error: "missing delivery id" }, { status: 400 });
  if (!recordDelivery(delivery, event)) return Response.json({ ok: true, duplicate: true });

  const payload = JSON.parse(raw) as {
    action?: string;
    installation?: Installation;
    ref?: string;
    after?: string;
    deleted?: boolean;
    repository?: { name: string; owner: { login: string } };
    head_commit?: { message: string; author?: { name?: string } } | null;
  };
  const deployed: number[] = [];
  switch (event) {
    case "installation":
      if (payload.installation) {
        if (payload.action === "deleted") removeInstallation(payload.installation.id);
        else upsertInstallation(payload.installation);
      }
      forgetRepos();
      break;
    case "installation_repositories":
      // Repositories added to or removed from an installation: the New project list changes.
      forgetRepos();
      break;
    case "push": {
      // Deploy every project that tracks this repo and branch (auto-deploy on).
      const branch = payload.ref?.startsWith("refs/heads/") ? payload.ref.slice("refs/heads/".length) : null;
      if (!branch || payload.deleted || !payload.repository || !/^[0-9a-f]{40}$/.test(payload.after ?? "")) break;
      for (const project of projectsForPush(payload.repository.owner.login, payload.repository.name, branch)) {
        // Only projects imported through this installation (the signature proves GitHub sent it).
        if (project.installationId !== payload.installation?.id) continue;
        const d = createDeployment(project, "push", {
          sha: payload.after!,
          message: (payload.head_commit?.message ?? "").split("\n")[0]!.slice(0, 200),
          author: payload.head_commit?.author?.name ?? "",
        });
        deployed.push(d.id);
      }
      break;
    }
  }
  return Response.json({ ok: true, deployments: deployed }, { status: 202 });
}
