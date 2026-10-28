import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import type { ActionName, Response } from "./index.ts";

export const AGENT_SOCKET = "/run/layer/agent.sock";

export class AgentError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

export interface CallOptions {
  socket?: string;
  /** Receives streamed output (logs.tail with follow). */
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

/** Sends one request to the agent and resolves with its result (or throws AgentError). */
export function callAgent<T = unknown>(
  action: ActionName,
  params: Record<string, unknown> = {},
  opts: CallOptions = {},
): Promise<T> {
  const id = randomUUID().replaceAll("-", "");
  return new Promise((resolve, reject) => {
    const socket = connect(opts.socket ?? AGENT_SOCKET);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    opts.signal?.addEventListener("abort", () => finish(() => reject(new AgentError("aborted", "aborted"))));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ id, action, params }) + "\n"));
    socket.on("data", (data: string) => {
      buffer += data;
      let i: number;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const res = JSON.parse(buffer.slice(0, i)) as Response;
        buffer = buffer.slice(i + 1);
        if ("chunk" in res) {
          opts.onChunk?.(res.chunk);
        } else if (res.ok) {
          finish(() => resolve(res.result as T));
        } else {
          finish(() => reject(new AgentError(res.error.code, res.error.message)));
        }
      }
    });
    socket.on("error", (err) => finish(() => reject(new AgentError("connect_failed", err.message))));
    socket.on("close", () => finish(() => reject(new AgentError("closed", "agent closed the connection"))));
  });
}
