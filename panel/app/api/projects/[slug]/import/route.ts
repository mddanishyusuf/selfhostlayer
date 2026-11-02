import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { AgentError } from "@layer/protocol";
import { agent } from "@/lib/agent";
import { config } from "@/lib/config";
import { panelOrigin } from "@/lib/origin";
import { getProjectBySlug } from "@/lib/projects";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const MAX_BYTES = 20 * 1024 ** 3;

export interface ImportResult {
  /** The replaced data, kept beside data/ (null when a database was new). */
  previous: string | null;
  /** Set when the upload was a single SQLite database: the file in data/ it replaced. */
  database?: string;
  sqlite: { path: string; bytes: number }[];
  files: number;
  bytes: number;
  restarted: string[];
}

const fail = (error: string, status: number) => Response.json({ error }, { status });

/**
 * A data/ archive from another server, or a single SQLite database. The body
 * is the file itself, ?name= its name and ?confirm=<slug> the typed confirmation. It streams to the restore folder,
 * then the agent checks it and swaps it in (data.import); the file is
 * deleted either way.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session?.mfaOk) return fail("Sign in again.", 401);
  // The session cookie is SameSite=Lax already; this makes a cross-site post fail before any upload.
  if (request.headers.get("origin") !== (await panelOrigin())) return fail("This request didn't come from the panel.", 403);
  const project = getProjectBySlug((await params).slug);
  if (!project) return fail("Project not found.", 404);
  if (new URL(request.url).searchParams.get("confirm") !== project.slug) return fail(`Type ${project.slug} to confirm.`, 400);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!request.body || !length) return fail("Choose a file first.", 400);
  if (length > MAX_BYTES) return fail("The archive is over 20 GB.", 413);
  const disk = statfsSync(config.dataDir);
  if (length * 3 > disk.bavail * disk.bsize) return fail("Not enough free disk: an import needs about three times the archive's size.", 507);

  const dir = join(config.dataDir, "restore");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${project.slug}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}.tar.gz`;
  const path = join(dir, file);
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      done(received > length ? new Error("The upload was longer than it said.") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(request.body as WebReadableStream), limit, createWriteStream(path, { mode: 0o600, flags: "wx" }));
    if (received !== length) return fail("The upload was cut off. Nothing changed.", 400);
    const search = new URL(request.url).searchParams;
    // A Sites WordPress brought in from another server: its wp-content and a .sql dump.
    if (search.get("kind") === "wordpress") {
      if (project.source !== "site" || project.catalogApp !== "wordpress") return fail("Only a WordPress site takes a WordPress import.", 400);
      const result = await agent<{ oldUrl: string; url: string; replaced: number }>("wordpress.import", { slug: project.slug, file });
      return Response.json({ ok: true, ...result });
    }
    const name = search.get("name") ?? "";
    const result = await agent<ImportResult>("data.import", { slug: project.slug, file, ...(name ? { name } : {}) });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return fail(err instanceof AgentError || err instanceof Error ? err.message : "The import failed. Nothing changed.", 422);
  } finally {
    rmSync(path, { force: true });
  }
}
