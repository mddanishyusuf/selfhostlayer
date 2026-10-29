import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseChannel, send } from "./notify";
import { buildMessage, sendMail, type SmtpConfig } from "./smtp";

/** A tiny SMTP server: records the conversation; AUTH works for "u"/"p" only. */
function fakeSmtp(opts: { authMethods?: string } = {}) {
  const sessions: { lines: string[]; data: string }[] = [];
  const server: Server = createServer((socket) => {
    const session = { lines: [] as string[], data: "" };
    sessions.push(session);
    let buffer = "";
    let inData = false;
    let loginStep = 0;
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued\r\n");
          } else session.data += line + "\n";
          continue;
        }
        session.lines.push(line);
        if (loginStep === 1) {
          loginStep = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (loginStep === 2) {
          loginStep = 0;
          socket.write(Buffer.from(line, "base64").toString() === "p" ? "235 ok\r\n" : "535 bad\r\n");
        } else if (line.startsWith("EHLO")) socket.write(`250-fake\r\n250-AUTH ${opts.authMethods ?? "PLAIN LOGIN"}\r\n250 SIZE 1000000\r\n`);
        else if (line.startsWith("AUTH PLAIN ")) socket.write(Buffer.from(line.slice(11), "base64").toString() === "\0u\0p" ? "235 ok\r\n" : "535 5.7.8 bad credentials\r\n");
        else if (line === "AUTH LOGIN") {
          loginStep = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 ok\r\n");
        else if (line === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("502 nope\r\n");
      }
    });
  });
  return { server, sessions };
}

describe("SMTP", () => {
  const plain = fakeSmtp();
  const loginOnly = fakeSmtp({ authMethods: "LOGIN" });
  const config = (port: number, extra: Partial<SmtpConfig> = {}): SmtpConfig => ({ host: "127.0.0.1", port, security: "none", user: "u", pass: "p", from: "alerts@example.com", to: ["me@example.com", "you@example.com"], ...extra });
  let port = 0;
  let loginPort = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => plain.server.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => loginOnly.server.listen(0, "127.0.0.1", r));
    port = (plain.server.address() as { port: number }).port;
    loginPort = (loginOnly.server.address() as { port: number }).port;
  });
  afterAll(() => {
    plain.server.close();
    loginOnly.server.close();
  });

  it("logs in, sends to every recipient, and dot-stuffs the body", async () => {
    await sendMail(config(port), { subject: "Deploy failed: piqo", text: "line one\n.hidden dot line\nlast" });
    const s = plain.sessions.at(-1)!;
    expect(s.lines).toEqual(expect.arrayContaining(["MAIL FROM:<alerts@example.com>", "RCPT TO:<me@example.com>", "RCPT TO:<you@example.com>", "DATA"]));
    expect(s.data).toContain("Subject: Deploy failed: piqo");
    const body = Buffer.from(s.data.split("\n\n")[1]!.replace(/\n/g, ""), "base64").toString();
    expect(body).toBe("line one\r\n.hidden dot line\r\nlast");
  });

  it("falls back to AUTH LOGIN and reports bad credentials", async () => {
    await sendMail(config(loginPort), { subject: "x", text: "y" });
    expect(loginOnly.sessions.at(-1)!.lines).toContain("AUTH LOGIN");
    await expect(sendMail(config(port, { pass: "wrong" }), { subject: "x", text: "y" })).rejects.toThrow(/login: 535/);
  });

  it("encodes non-ASCII subjects", () => {
    expect(buildMessage(config(port), { subject: "Déploiement échoué", text: "" })).toContain("Subject: =?UTF-8?B?");
  });

  it("explains an unreachable server", async () => {
    await expect(sendMail(config(1), { subject: "x", text: "y" })).rejects.toThrow();
  });

  it("formats alerts as email and validates the channel", async () => {
    const sent: { subject: string; text: string }[] = [];
    const parsed = parseChannel("email", { host: "smtp.resend.com", port: "587", security: "starttls", user: "resend", pass: "re_x", from: "alerts@example.com", to: "me@example.com, ops@example.com" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await send(parsed.config, { event: "opened", key: "disk", title: "Disk 85% full", detail: "Free some space.", link: null, at: "" }, "cx23", fetch, async (_c, m) => void sent.push(m));
    expect(sent[0]).toEqual({ subject: "Alert: Disk 85% full (cx23)", text: "Disk 85% full\nFree some space.\n— cx23" });
    expect(parseChannel("email", { host: "smtp.example.com", security: "none", from: "a@b.co", to: "c@d.co" })).toMatchObject({ ok: false, error: expect.stringContaining("Unencrypted") });
    expect(parseChannel("email", { host: "smtp.example.com", from: "nope", to: "c@d.co" })).toMatchObject({ ok: false, error: expect.stringContaining("From") });
  });
});
