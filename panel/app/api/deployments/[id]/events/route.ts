import { events, FINISHED, getDeployment, readLog, type DeployStatus } from "@/lib/deploy";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Server-Sent Events: the log so far, then new log text and status changes until the deployment finishes. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return new Response("unauthorized", { status: 401 });
  const id = Number((await params).id);
  const deployment = getDeployment(id);
  if (!deployment) return new Response("not found", { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const onLog = (text: string) => send("log", text);
      const onStatus = (status: DeployStatus) => {
        send("status", getDeployment(id));
        if (FINISHED.includes(status)) close();
      };
      const keepAlive = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 15_000);
      const close = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      cleanup = () => {
        clearInterval(keepAlive);
        events.off(`log:${id}`, onLog);
        events.off(`status:${id}`, onStatus);
      };
      send("log", readLog(id));
      send("status", getDeployment(id));
      if (FINISHED.includes(deployment.status)) return close();
      events.on(`log:${id}`, onLog);
      events.on(`status:${id}`, onStatus);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
