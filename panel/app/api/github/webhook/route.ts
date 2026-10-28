import { verifyWebhookSignature, type Installation } from "@/lib/github";
import { getApp, recordDelivery, removeInstallation, upsertInstallation } from "@/lib/github-store";

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

  const payload = JSON.parse(raw) as { action?: string; installation?: Installation };
  switch (event) {
    case "installation":
      if (payload.installation) {
        if (payload.action === "deleted") removeInstallation(payload.installation.id);
        else upsertInstallation(payload.installation);
      }
      break;
    case "push":
      // Day 6: deploy the project tracking this repo and branch.
      break;
  }
  return Response.json({ ok: true }, { status: 202 });
}
