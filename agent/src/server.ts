import { chmodSync, chownSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Response } from "@layer/protocol";
import type { CallIO } from "./context.ts";
import { MAX_LINE_BYTES, type Dispatcher } from "./dispatch.ts";

const MAX_CONNECTIONS = 16;
const IDLE_TIMEOUT_MS = 5 * 60_000;

export interface SocketAccess {
  /** Group allowed to connect; null leaves ownership alone (tests). */
  gid: number | null;
}

/**
 * Newline-delimited JSON over a unix socket. Access control is the file mode:
 * the socket and its directory are root:<panel group>, so only root and the
 * panel can connect.
 */
export function listen(path: string, dispatcher: Dispatcher, access: SocketAccess): Promise<Server> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  chmodSync(dir, 0o750);
  if (access.gid !== null) chownSync(dir, 0, access.gid);
  if (existsSync(path)) rmSync(path);

  // allowHalfOpen: a client may send its requests and then close its side
  // (`printf … | socat - UNIX-CONNECT:…`); answer everything before closing ours.
  const server = createServer({ allowHalfOpen: true }, (socket) => serve(socket, dispatcher));
  server.maxConnections = MAX_CONNECTIONS;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      chmodSync(path, 0o660);
      if (access.gid !== null) chownSync(path, 0, access.gid);
      resolve(server);
    });
  });
}

function serve(socket: Socket, dispatcher: Dispatcher): void {
  socket.setEncoding("utf8");
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
  let buffer = "";
  let pending = 0;
  let clientDone = false;
  // Aborts every streaming call on this connection when it closes.
  const closed = new AbortController();
  socket.on("close", () => closed.abort());
  const makeIO = (id: string): CallIO => ({
    emit: (chunk) => send({ id, chunk }),
    signal: closed.signal,
  });

  const send = (response: Response) => {
    if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
  };
  const endIfIdle = () => {
    if (clientDone && pending === 0 && !socket.destroyed) socket.end();
  };
  const dispatch = (line: string) => {
    pending++;
    void dispatcher.handleLine(line, makeIO).then(send).finally(() => {
      pending--;
      endIfIdle();
    });
  };

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) dispatch(line);
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      send({ id: null, ok: false, error: { code: "too_large", message: `request over ${MAX_LINE_BYTES} bytes` } });
      socket.end();
      buffer = "";
    }
  });
  socket.on("end", () => {
    // A last request without a trailing newline still counts.
    const line = buffer.trim();
    buffer = "";
    if (line && Buffer.byteLength(line) <= MAX_LINE_BYTES) dispatch(line);
    clientDone = true;
    endIfIdle();
  });
  socket.on("error", () => socket.destroy());
}
