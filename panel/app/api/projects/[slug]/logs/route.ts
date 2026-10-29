import { agent } from "@/lib/agent";
import { getProjectBySlug } from "@/lib/projects";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Server-Sent Events: the app's last 300 journal lines, then new ones as they're written. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return new Response("unauthorized", { status: 401 });
  const project = getProjectBySlug((await params).slug);
  if (!project) return new Response("not found", { status: 404 });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  // The browser closing the page aborts the agent call, which stops journalctl.
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // the client went away
        }
      };
      const keepAlive = setInterval(() => send("ping", ""), 15_000);
      agent("logs.tail", { slug: project.slug, lines: 300, follow: true }, { onChunk: (chunk) => send("log", chunk), signal: abort.signal })
        .catch((err: Error) => send("log", `\n[layer] logs stopped: ${err.message}\n`))
        .finally(() => {
          clearInterval(keepAlive);
          send("end", "");
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
