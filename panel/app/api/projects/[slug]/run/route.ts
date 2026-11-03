import { AgentError } from "@layer/protocol";
import { agent } from "@/lib/agent";
import { panelOrigin } from "@/lib/origin";
import { parseStartCommand } from "@/lib/project-settings";
import { getProjectBySlug } from "@/lib/projects";
import { getSession } from "@/lib/session";
import { hasProcesses } from "@/lib/workers";

export const dynamic = "force-dynamic";

export interface RunEnd {
  code: number;
  ms: number;
  timedOut: boolean;
}

const fail = (error: string, status: number) => Response.json({ error }, { status });

/**
 * Runs one command in the project's live release (app.run) and streams it
 * back as JSON lines: {"log": chunk}…, then {"end": {code, ms, timedOut}} or
 * {"error": message}. The body is {"command": "npm run migrate"}. The browser
 * leaving stops the command.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return fail("Sign in again.", 401);
  // The session cookie is SameSite=Lax already; this refuses a post from another site outright.
  if (request.headers.get("origin") !== (await panelOrigin())) return fail("This request didn't come from the panel.", 403);
  const project = getProjectBySlug((await params).slug);
  if (!project || !hasProcesses(project)) return fail("Project not found.", 404);
  const body = (await request.json().catch(() => null)) as { command?: unknown } | null;
  const exec = parseStartCommand(typeof body?.command === "string" ? body.command : "");
  if (typeof exec === "string") return fail(exec.replace("start command", "command"), 400);

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const stream = new ReadableStream({
    start(controller) {
      const send = (line: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // the client went away
        }
      };
      agent<RunEnd>(
        "app.run",
        {
          slug: project.slug,
          nodeVersion: project.nodeVersion,
          exec,
          rootDir: project.rootDir,
          // At least 1 GB: a migration may need more than the app itself.
          memoryMb: Math.max(1024, project.memoryMb),
          timeoutSec: 3600,
          writablePaths: project.runtime.kind === "node" ? project.runtime.writablePaths : [],
        },
        { onChunk: (chunk) => send({ log: chunk }), signal: abort.signal },
      )
        .then((end) => send({ end: { code: end.code, ms: end.ms, timedOut: end.timedOut } }))
        .catch((err: unknown) => send({ error: err instanceof AgentError || err instanceof Error ? err.message : String(err) }))
        .finally(() => {
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
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
