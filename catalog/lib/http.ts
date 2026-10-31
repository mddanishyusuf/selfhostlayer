// Small helpers for node:http, shared by the catalog apps: answers, bodies
// with a size limit, bearer tokens, and InputError (a field and a message,
// answered with its status).
import type { IncomingMessage, ServerResponse } from "node:http";

export class InputError extends Error {
  readonly field: string;
  readonly status: number;
  constructor(field: string, message: string, status = 400) {
    super(message);
    this.field = field;
    this.status = status;
  }
}

const BASE_HEADERS = { "X-Content-Type-Options": "nosniff" };

export function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Length": String(Buffer.byteLength(body)), ...headers });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, `${JSON.stringify(data)}\n`, { "Content-Type": "application/json", "Cache-Control": "no-store" });
}

export function html(res: ServerResponse, status: number, page: string, headers: Record<string, string> = {}): void {
  send(res, status, page, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    ...headers,
  });
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new InputError("body", `the request is over ${Math.round(limit / 1024)} KB`, 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const body = (await readBody(req, limit)).toString("utf8");
  if (!body.trim()) return {};
  try {
    const value = JSON.parse(body) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new InputError("body", "must be a JSON object");
  }
}

export function bearer(req: IncomingMessage): string | null {
  return /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? null;
}

/** Answers a thrown InputError with its status and field; anything else is logged and answered 500. */
export function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof InputError) return json(res, err.status, { error: err.message, field: err.field });
  console.error(err);
  json(res, 500, { error: "something went wrong on the server" });
}
