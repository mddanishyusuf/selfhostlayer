// A small SMTP server for tests: STARTTLS or TLS from the start, AUTH PLAIN
// and LOGIN, recipients refused on request; it keeps what it was sent.
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { TEST_CERT, TEST_KEY } from "./fixtures.ts";

export interface Received {
  from: string;
  to: string[];
  data: string;
  user: string | null;
}

export interface FakeSmtp {
  port: number;
  received: Received[];
  /** Commands seen, in order (passwords left out). */
  log: string[];
  connections: number;
  close(): Promise<void>;
}

export async function fakeSmtp(o: { security: "starttls" | "tls" | "none"; user?: string; pass?: string; refuse?: (to: string) => string | null; dropAfter?: number } = { security: "starttls" }): Promise<FakeSmtp> {
  const received: Received[] = [];
  const log: string[] = [];
  let connections = 0;
  const sockets = new Set<Socket>();

  function session(raw: Socket) {
    connections++;
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    let socket: Socket = raw;
    let tls = o.security === "tls";
    let buffer = "";
    let user: string | null = null;
    let mail: { from: string; to: string[] } | null = null;
    let data: string[] | null = null;
    let login: "user" | "pass" | null = null;
    let loginUser = "";
    let sent = 0;
    const say = (line: string) => socket.write(`${line}\r\n`);
    const auth = (u: string, p: string) => {
      if (u === o.user && p === o.pass) {
        user = u;
        say("235 2.7.0 ok");
      } else say("535 5.7.8 bad credentials");
    };
    const onLine = (line: string) => {
      if (data) {
        if (line === ".") {
          received.push({ from: mail!.from, to: mail!.to, data: data.join("\r\n"), user });
          data = null;
          mail = null;
          sent++;
          say(`250 2.0.0 Ok: queued as Q${received.length}`);
          if (o.dropAfter && sent >= o.dropAfter) socket.destroy();
        } else data.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }
      if (login === "user") {
        loginUser = Buffer.from(line, "base64").toString();
        login = "pass";
        return say("334 UGFzc3dvcmQ6");
      }
      if (login === "pass") {
        login = null;
        return auth(loginUser, Buffer.from(line, "base64").toString());
      }
      const verb = line.split(" ")[0]!.toUpperCase();
      log.push(verb === "AUTH" ? line.split(" ").slice(0, 2).join(" ") : line);
      if (verb === "EHLO") {
        const ext = ["250-fake.test", ...(o.security === "starttls" && !tls ? ["250-STARTTLS"] : []), "250-AUTH PLAIN LOGIN", "250 8BITMIME"];
        return ext.forEach(say);
      }
      if (verb === "STARTTLS") {
        say("220 2.0.0 go ahead");
        socket.removeAllListeners("data");
        const secure = new TLSSocket(socket, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
        socket = secure;
        tls = true;
        secure.setEncoding("utf8");
        secure.on("data", onData);
        return;
      }
      if (verb === "AUTH") {
        if (o.security !== "none" && !tls) return say("530 5.7.0 must issue STARTTLS first");
        const [, kind, arg] = line.split(" ");
        if (kind?.toUpperCase() === "PLAIN") {
          const [, u, p] = Buffer.from(arg ?? "", "base64").toString().split("\u0000");
          return auth(u ?? "", p ?? "");
        }
        login = "user";
        return say("334 VXNlcm5hbWU6");
      }
      if (verb === "MAIL") {
        if (o.user && !user) return say("530 5.7.0 authentication required");
        mail = { from: /<([^>]*)>/.exec(line)?.[1] ?? "", to: [] };
        return say("250 2.1.0 ok");
      }
      if (verb === "RCPT") {
        const to = /<([^>]*)>/.exec(line)?.[1] ?? "";
        const refused = o.refuse?.(to);
        if (refused) return say(refused);
        mail?.to.push(to);
        return say("250 2.1.5 ok");
      }
      if (verb === "DATA") {
        data = [];
        return say("354 end with .");
      }
      if (verb === "RSET") {
        mail = null;
        return say("250 2.0.0 ok");
      }
      if (verb === "QUIT") {
        say("221 2.0.0 bye");
        return socket.end();
      }
      say("502 5.5.2 not implemented");
    };
    const onData = (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        onLine(line);
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", onData);
    socket.on("error", () => {});
    say("220 fake.test ESMTP");
  }

  const server: Server = o.security === "tls" ? createTlsServer({ key: TEST_KEY, cert: TEST_CERT }, session) : createServer(session);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    log,
    get connections() {
      return connections;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
