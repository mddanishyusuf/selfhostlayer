import { statSync } from "node:fs";
import { connect, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Response } from "@layer/protocol";
import { MAX_LINE_BYTES, type Dispatcher } from "../src/dispatch.ts";
import { listen } from "../src/server.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let server: Server;

// Echoes the request id back, so tests can check framing.
const echo: Dispatcher = {
  handleLine: async (line) => ({ id: JSON.parse(line).id, ok: true, result: null }),
};

/** Sends raw bytes (in the given chunks) and collects n response lines. */
function exchange(chunks: string[], n: number): Promise<Response[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(env.paths.socket);
    let buffer = "";
    const lines: Response[] = [];
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      buffer += data;
      let i: number;
      while ((i = buffer.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
      if (lines.length >= n) {
        socket.destroy();
        resolve(lines);
      }
    });
    socket.on("error", reject);
    (async () => {
      for (const chunk of chunks) {
        socket.write(chunk);
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
  });
}

beforeEach(async () => {
  env = testEnv();
  server = await listen(env.paths.socket, echo, { gid: null });
});
afterEach(() => {
  server.close();
  env.cleanup();
});

describe("unix socket server", () => {
  it("creates the socket with mode 660 inside a 750 directory", () => {
    expect((statSync(env.paths.socket).mode & 0o777).toString(8)).toBe("660");
  });

  it("handles several requests in one chunk", async () => {
    const res = await exchange(['{"id":"a"}\n{"id":"b"}\n'], 2);
    expect(res.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("reassembles a request split across chunks", async () => {
    const res = await exchange(['{"i', 'd":"split"', "}\n"], 1);
    expect(res[0]!.id).toBe("split");
  });

  it("answers a slow request after the client half-closes, then closes (socat style)", async () => {
    server.close();
    const slow: Dispatcher = {
      handleLine: async (line) => {
        await new Promise((r) => setTimeout(r, 50));
        return { id: JSON.parse(line).id, ok: true, result: null };
      },
    };
    server = await listen(env.paths.socket, slow, { gid: null });
    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect(env.paths.socket);
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (d: string) => (data += d));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      // No trailing newline, then EOF, exactly like `printf '{...}' | socat`.
      socket.end('{"id":"slow"}');
    });
    expect(JSON.parse(received)).toMatchObject({ id: "slow", ok: true });
  });

  it("rejects a request over the size limit and closes the connection", async () => {
    const res = await exchange(["x".repeat(MAX_LINE_BYTES + 10)], 1);
    expect(res[0]).toMatchObject({ id: null, ok: false, error: { code: "too_large" } });
  });
});
