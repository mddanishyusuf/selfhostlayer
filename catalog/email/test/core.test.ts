import { createSign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Brands } from "../src/brands.ts";
import { openDb } from "../src/db.ts";
import { dkimSign, dkimVerify, newKeyPair, relaxedBody } from "../src/dkim.ts";
import { Domains, type Dns } from "../src/domains.ts";
import { buildMessage, checkHeaders, parseAddress, parseAddresses, quotedPrintable } from "../src/mime.ts";
import { SendError, SmtpSender } from "../src/providers.ts";
import { Secrets } from "../../lib/secrets.ts";
import { Ses, signV4, snsSignedText, verifySns, type SnsMessage } from "../src/ses.ts";
import { fakeSmtp, type FakeSmtp } from "./fake-smtp.ts";
import { TEST_CERT, TEST_KEY } from "./fixtures.ts";

const secrets = new Secrets("a".repeat(64), "b".repeat(64), "email");

describe("messages", () => {
  it("parse addresses, with names, and refuse what isn't one", () => {
    expect(parseAddress("Ada Lovelace <ada@example.com>", "from")).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(parseAddress('"Lovelace, Ada" <ada@example.com>', "from")).toEqual({ name: "Lovelace, Ada", email: "ada@example.com" });
    expect(parseAddress(" ada@example.com ", "to")).toEqual({ email: "ada@example.com" });
    expect(parseAddresses(["a@example.com", "B <b@example.org>"], "to")).toHaveLength(2);
    for (const bad of ["ada", "ada@localhost", "a b@example.com", "<>", "x@example.com\r\nBcc: y@example.com"]) expect(() => parseAddress(bad, "to")).toThrow();
  });

  it("are MIME: encoded subject and names, quoted-printable bodies, attachments, one-click unsubscribe", () => {
    const raw = buildMessage({
      from: { name: "Zoë from Piqo", email: "zoe@piqo.app" },
      to: [{ email: "ada@example.com" }],
      replyTo: [{ email: "help@piqo.app" }],
      subject: "Héllo — a subject long enough that it has to be folded over more than one line ✓",
      text: "Hi Ada,\n\nCafé at 10?\n.leading dot",
      html: `<p style="color: red">${"x".repeat(200)} é</p>`,
      headers: { "X-Entity-Ref-ID": "abc" },
      attachments: [{ filename: "notes.txt", content: Buffer.from("hello"), contentType: "text/plain" }],
      id: "m1",
      date: new Date(Date.UTC(2026, 9, 31, 21, 25, 21)),
      unsubscribe: { url: "https://mail.example.com/u/m1.sig", oneClick: true },
    }).toString();
    const [head, ...rest] = raw.split("\r\n\r\n");
    expect(head).toContain("From: =?UTF-8?B?");
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?[^\r]+\r\n =\?UTF-8\?B\?/);
    expect(head).toContain("Date: Sat, 31 Oct 2026 21:25:21 +0000");
    expect(head).toContain("Message-ID: <m1@piqo.app>");
    expect(head).toContain("List-Unsubscribe: <https://mail.example.com/u/m1.sig>");
    expect(head).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(head).toMatch(/Content-Type: multipart\/mixed; boundary="=_[0-9a-f]+"/);
    const body = rest.join("\r\n\r\n");
    expect(body).toContain("multipart/alternative");
    expect(body).toContain("Caf=C3=A9 at 10?");
    expect(body).toContain('filename="notes.txt"');
    expect(body).toContain(Buffer.from("hello").toString("base64"));
    expect(raw.split("\r\n").every((l) => l.length <= 998)).toBe(true);
    expect(raw.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("encode quoted-printable under 76 columns, spaces at line ends kept", () => {
    const qp = quotedPrintable(`${"a".repeat(100)}\nend \n=`);
    expect(qp.split("\r\n").every((l) => l.length <= 76)).toBe(true);
    expect(qp).toContain("end=20");
    expect(qp.endsWith("=3D")).toBe(true);
  });

  it("refuse headers they write themselves, or on two lines", () => {
    expect(checkHeaders({ "X-Campaign": "launch" })).toEqual({ "X-Campaign": "launch" });
    expect(() => checkHeaders({ Bcc: "x@example.com" })).toThrow();
    expect(() => checkHeaders({ "X-A": "1\r\nBcc: x@example.com" })).toThrow();
    expect(() => checkHeaders({ "X A": "1" })).toThrow();
  });
});

describe("DKIM", () => {
  const keys = newKeyPair();
  const message = () => buildMessage({ from: { email: "news@piqo.app" }, to: [{ email: "ada@example.com" }], subject: "Hi", text: "Hello  there \n\n\n", html: "<p>Hello</p>", id: "x1" });

  it("signs relaxed/relaxed, and the signature checks out", () => {
    const signed = dkimSign(message(), { domain: "piqo.app", selector: "shl1", privateKey: keys.privatePem });
    const head = signed.toString().split("\r\n\r\n")[0]!;
    expect(head).toMatch(/^DKIM-Signature: v=1;\r\n\ta=rsa-sha256;\r\n\tc=relaxed\/relaxed;\r\n\td=piqo\.app;\r\n\ts=shl1;/);
    expect(head).toMatch(/h=from:to:subject:date:message-id:mime-version:content-type;/);
    expect(head.split("\r\n").every((l) => l.length <= 100)).toBe(true);
    expect(dkimVerify(signed, keys.publicBase64)).toEqual({ ok: true });
  });

  it("fails when the body or a signed header changes, or with another key", () => {
    const signed = dkimSign(message(), { domain: "piqo.app", selector: "shl1", privateKey: keys.privatePem }).toString();
    expect(dkimVerify(Buffer.from(signed.replace("Hello  there", "Hello there!")), keys.publicBase64).ok).toBe(false);
    expect(dkimVerify(Buffer.from(signed.replace("Subject: Hi", "Subject: Hey")), keys.publicBase64)).toEqual({ ok: false, reason: "the signature doesn't match" });
    // Relaxed canonicalization: spaces folded and blank lines at the end don't matter.
    expect(dkimVerify(Buffer.from(signed.replace("Subject: Hi", "Subject:   Hi")), keys.publicBase64).ok).toBe(true);
    expect(dkimVerify(Buffer.from(signed), newKeyPair().publicBase64).ok).toBe(false);
    expect(relaxedBody("a  b \r\n\r\n\r\n")).toBe("a b\r\n");
    expect(relaxedBody("")).toBe("");
  });
});

describe("SMTP", () => {
  let server: FakeSmtp;
  let sender: SmtpSender | undefined;
  afterEach(async () => {
    await sender?.close();
    await server?.close();
  });
  const keys = newKeyPair();
  const mail = (to: string, text = "Hi") => ({ from: "news@piqo.app", fromDomain: "piqo.app", to: [to], raw: buildMessage({ from: { email: "news@piqo.app" }, to: [{ email: to }], subject: "Hi", text, id: "x" }) });

  it("sends over STARTTLS with AUTH PLAIN, signed with DKIM, on one connection for several messages", async () => {
    server = await fakeSmtp({ security: "starttls", user: "apikey", pass: "secret" });
    sender = new SmtpSender({ host: "localhost", port: server.port, security: "starttls", username: "apikey", password: "secret" }, { dkim: () => ({ selector: "shl1", privateKey: keys.privatePem }), name: () => "mail.example.com", ca: TEST_CERT });
    const a = await sender.send(mail("ada@example.com", "line one\n.starts with a dot"));
    const b = await sender.send(mail("bob@example.com"));
    expect([a.providerId, b.providerId]).toEqual(["Q1", "Q2"]);
    expect(server.connections).toBe(1);
    expect(server.log.slice(0, 4)).toEqual(["EHLO mail.example.com", "STARTTLS", "EHLO mail.example.com", "AUTH PLAIN"]);
    const got = server.received[0]!;
    expect([got.from, got.to, got.user]).toEqual(["news@piqo.app", ["ada@example.com"], "apikey"]);
    expect(got.data).toContain("\r\n.starts with a dot");
    expect(dkimVerify(Buffer.from(`${got.data}\r\n`), keys.publicBase64)).toEqual({ ok: true });
  });

  it("sends over TLS from the start; a refused recipient is a permanent bounce; a dropped connection is reopened", async () => {
    server = await fakeSmtp({ security: "tls", user: "u", pass: "p", refuse: (to) => (to.startsWith("nobody") ? "550 5.1.1 no such user" : to.startsWith("full") ? "452 4.2.2 mailbox full" : null), dropAfter: 1 });
    sender = new SmtpSender({ host: "localhost", port: server.port, security: "tls", username: "u", password: "p" }, { dkim: () => null, name: () => "mail.example.com", ca: TEST_CERT });
    await sender.send(mail("ada@example.com"));
    // The server hung up after one message: the next one opens a new connection.
    await sender.send(mail("bob@example.com"));
    expect(server.connections).toBe(2);
    const bounce = await sender.send(mail("nobody@example.com")).catch((e: SendError) => e);
    expect(bounce).toBeInstanceOf(SendError);
    expect([(bounce as SendError).permanent, (bounce as SendError).bounce]).toEqual([true, true]);
    const later = (await sender.send(mail("full@example.com")).catch((e: SendError) => e)) as SendError;
    expect([later.permanent, later.bounce]).toEqual([false, false]);
  });

  it("says why it can't log in, and refuses to send credentials without STARTTLS", async () => {
    server = await fakeSmtp({ security: "starttls", user: "u", pass: "p" });
    sender = new SmtpSender({ host: "localhost", port: server.port, security: "starttls", username: "u", password: "wrong" }, { dkim: () => null, name: () => "x.test", ca: TEST_CERT });
    await expect(sender.send(mail("ada@example.com"))).rejects.toThrow(/AUTH: 535/);
    await sender.close();
    await server.close();
    server = await fakeSmtp({ security: "none" });
    sender = new SmtpSender({ host: "localhost", port: server.port, security: "starttls", username: "u", password: "p" }, { dkim: () => null, name: () => "x.test" });
    await expect(sender.send(mail("ada@example.com"))).rejects.toThrow(/doesn't offer STARTTLS/);
  });
});

describe("Amazon SES", () => {
  it("signs requests as AWS's Signature Version 4 test suite does", () => {
    const base = { host: "example.amazonaws.com", body: "", service: "service", region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", now: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)) };
    expect(signV4({ ...base, method: "GET", path: "/" }).authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(signV4({ ...base, method: "GET", path: "/", query: { Param2: "value2", Param1: "value1" } }).authorization).toContain("Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });

  it("sends raw messages through SESv2, and says what SES answered", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let answer: { status: number; body: unknown } = { status: 200, body: { MessageId: "ses-1" } };
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const ses = new Ses({ region: "eu-west-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "secret" }, { fetch: fakeFetch });
    expect(await ses.sendRaw({ from: "news@piqo.app", to: ["ada@example.com"], raw: Buffer.from("raw"), configurationSet: "shl-1" })).toBe("ses-1");
    expect(calls[0]!.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ FromEmailAddress: "news@piqo.app", Destination: { ToAddresses: ["ada@example.com"] }, Content: { Raw: { Data: "cmF3" } }, ConfigurationSetName: "shl-1" });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request/);
    answer = { status: 400, body: { message: "Email address is not verified.", __type: "MessageRejected" } };
    await expect(ses.sendRaw({ from: "x@y.com", to: ["a@b.com"], raw: Buffer.from("r") })).rejects.toMatchObject({ message: "Amazon SES answered 400 MessageRejected: Email address is not verified.", transient: false });
    answer = { status: 429, body: { message: "Maximum sending rate exceeded.", __type: "TooManyRequestsException" } };
    await expect(ses.sendRaw({ from: "x@y.com", to: ["a@b.com"], raw: Buffer.from("r") })).rejects.toMatchObject({ transient: true });
    expect(() => new Ses({ region: "nowhere", accessKeyId: "A", secretAccessKey: "s" })).toThrow(/region/);
  });

  it("believes SNS messages only when SNS signed them, from SNS's own address", async () => {
    const m: SnsMessage = { Type: "Notification", MessageId: "1", TopicArn: "arn:aws:sns:eu-west-1:1:shl", Message: '{"notificationType":"Bounce"}', Timestamp: "2026-10-31T00:00:00Z", SignatureVersion: "2", Signature: "", SigningCertURL: "https://sns.eu-west-1.amazonaws.com/x.pem" };
    m.Signature = createSign("RSA-SHA256").update(snsSignedText(m)).sign(TEST_KEY, "base64");
    expect(await verifySns(m, { certificate: TEST_CERT })).toBe(true);
    expect(await verifySns({ ...m, Message: '{"notificationType":"Complaint"}' }, { certificate: TEST_CERT })).toBe(false);
    expect(await verifySns({ ...m, SigningCertURL: "https://evil.example.com/x.pem" })).toBe(false);
  });
});

describe("domains", () => {
  it("get a DKIM key of their own, verified once its record is in public DNS; SPF and DMARC are checked too", async () => {
    const db = openDb(":memory:");
    const records = new Map<string, string[]>();
    const dns: Dns = { txt: async (n) => records.get(n) ?? [], cname: async () => [] };
    let brands!: Brands;
    const domains = new Domains({ db, secrets, brands: () => brands, dns });
    brands = new Brands({ db, secrets, dkim: (id) => domains.dkimFor(id), hostName: () => "mail.example.com" });
    const brand = brands.add({ name: "Piqo" });
    brands.setProvider(brand.id, { provider: "smtp", host: "smtp.example.com", port: 587, username: "u", password: "p" });
    const d = await domains.add(brand.id, "https://Piqo.app/");
    expect(d.domain).toBe("piqo.app");
    await expect(domains.add(brand.id, "piqo.app")).rejects.toThrow(/already/);
    const dkim = d.records.find((r) => r.purpose === "DKIM")!;
    expect(dkim).toMatchObject({ type: "TXT", name: `shl${brand.id}._domainkey.piqo.app`, required: true, ok: null });
    expect((await domains.verify(brand.id, d.id)).status).toBe("failed");
    expect(domains.verifiedFor(brand.id, "news@piqo.app")).toBe(false);
    // The record as DNS hosts often split it: in pieces, with spaces.
    records.set(dkim.name, [dkim.value.replace("p=", "p= ")]);
    records.set("piqo.app", ["v=spf1 include:_spf.example.com ~all", "google-site-verification=x"]);
    const v = await domains.verify(brand.id, d.id);
    expect(v.status).toBe("verified");
    expect(v.records.map((r) => [r.purpose, r.ok])).toEqual([
      ["DKIM", true],
      ["SPF", true],
      ["DMARC", false],
    ]);
    expect(domains.verifiedFor(brand.id, "news@Piqo.app")).toBe(true);
    expect(domains.dkimFor(brand.id)("piqo.app")?.selector).toBe(`shl${brand.id}`);
    expect(JSON.stringify(db.prepare("SELECT * FROM domains").all())).not.toContain("PRIVATE KEY");
    // Another provider: checked again.
    brands.setProvider(brand.id, { provider: "smtp", host: "smtp.other.com", port: 465 });
    expect(domains.list(brand.id)[0]!.status).toBe("verified");
    brands.setProvider(brand.id, { provider: "none" });
    expect(domains.list(brand.id)[0]!.status).toBe("pending");
  });

  it("for an SES brand: SES's identity and its three Easy DKIM CNAMEs", async () => {
    const db = openDb(":memory:");
    let verified = false;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (init?.method === "POST" && u.pathname === "/v2/email/identities") return Response.json({ DkimAttributes: { Tokens: ["t1", "t2", "t3"] }, VerifiedForSendingStatus: false });
      if (u.pathname === "/v2/email/identities/piqo.app") return Response.json({ DkimAttributes: { Tokens: ["t1", "t2", "t3"], Status: verified ? "SUCCESS" : "PENDING" }, VerifiedForSendingStatus: verified });
      return Response.json({ message: "no" }, { status: 404 });
    }) as typeof fetch;
    let brands!: Brands;
    const dns: Dns = { txt: async () => [], cname: async (n) => (n.startsWith("t1.") ? ["t1.dkim.amazonses.com."] : []) };
    const domains = new Domains({ db, secrets, brands: () => brands, dns });
    brands = new Brands({ db, secrets, dkim: (id) => domains.dkimFor(id), hostName: () => "x", fetch: fakeFetch });
    const brand = brands.add({ name: "Piqo" });
    expect(() => brands.setProvider(brand.id, { provider: "ses", region: "eu-west-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE" })).toThrow(expect.objectContaining({ field: "secretAccessKey" }));
    brands.setProvider(brand.id, { provider: "ses", region: "eu-west-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "s" });
    const d = await domains.add(brand.id, "piqo.app");
    expect(d.records.filter((r) => r.type === "CNAME").map((r) => [r.name, r.value])).toEqual([
      ["t1._domainkey.piqo.app", "t1.dkim.amazonses.com"],
      ["t2._domainkey.piqo.app", "t2.dkim.amazonses.com"],
      ["t3._domainkey.piqo.app", "t3.dkim.amazonses.com"],
    ]);
    expect((await domains.verify(brand.id, d.id)).status).toBe("failed");
    verified = true;
    const v = await domains.verify(brand.id, d.id);
    expect(v.status).toBe("verified");
    expect(v.records.filter((r) => r.type === "CNAME").map((r) => r.ok)).toEqual([true, false, false]);
    // Another region: SES there has no identity yet, and Zurich's DKIM records point at its own domain.
    brands.setProvider(brand.id, { provider: "ses", region: "eu-central-2", accessKeyId: "AKIAIOSFODNN7EXAMPLE" });
    expect(domains.list(brand.id)[0]).toMatchObject({ status: "pending", verifiedAt: null });
    expect(domains.list(brand.id)[0]!.records.filter((r) => r.type === "CNAME")).toEqual([]);
    const moved = await domains.verify(brand.id, d.id);
    expect(moved.records.filter((r) => r.type === "CNAME").map((r) => [r.value, r.ok])).toEqual([
      ["t1.dkim.eu-central-2.amazonses.com", false],
      ["t2.dkim.eu-central-2.amazonses.com", false],
      ["t3.dkim.eu-central-2.amazonses.com", false],
    ]);
  });
});
