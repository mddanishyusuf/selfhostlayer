// Amazon SES through its API (SESv2) and SNS, with our own AWS Signature
// Version 4: no AWS SDK. What Email uses:
//   GetAccount                    the key works; sandbox or not, the send quota
//   SendEmail (raw)               our own MIME, so List-Unsubscribe and all are ours
//   Create/Get/DeleteEmailIdentity  a domain, and its Easy DKIM CNAMEs
//   CreateConfigurationSet (+ event destination), SNS CreateTopic and
//   Subscribe                     bounces and complaints sent to /webhooks/ses
// SNS's messages are checked against the certificate SNS signs with (only
// from sns.<region>.amazonaws.com) before anything in them is believed.
import { createHash, createHmac, createVerify, X509Certificate } from "node:crypto";

export interface AwsCredentials {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class AwsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** Throttling and AWS's own failures: worth another try. */
  get transient(): boolean {
    return this.status === 429 || this.status >= 500 || /Throttl|TooManyRequests/i.test(this.code);
  }
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding, as SigV4 wants it. */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** AWS Signature Version 4 headers for a request (exported for its test vectors). */
export function signV4(o: { method: string; host: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body: string; service: string; region: string; accessKeyId: string; secretAccessKey: string; now?: Date }): Record<string, string> {
  const amzDate = (o.now ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: o.host, "x-amz-date": amzDate };
  const names = Object.keys(headers).sort();
  const query = Object.entries(o.query ?? {})
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a! < b! ? -1 : a! > b! ? 1 : x! < y! ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path = o.path.split("/").map((s) => encode(decodeURIComponent(s))).join("/");
  const canonical = [o.method, path, query, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), sha256(o.body)].join("\n");
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), o.region), o.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export class Ses {
  readonly #c: AwsCredentials;
  readonly #fetch: typeof fetch;
  readonly #endpoint: string | null;

  /** endpoint: another address for both APIs (tests). */
  constructor(c: AwsCredentials, o: { fetch?: typeof fetch; endpoint?: string } = {}) {
    if (!REGION.test(c.region)) throw new AwsError(`${c.region} isn't an AWS region like us-east-1`, 400);
    this.#c = c;
    this.#fetch = o.fetch ?? fetch;
    this.#endpoint = o.endpoint ?? null;
  }

  async #call(service: "ses" | "sns", method: string, path: string, body: string, contentType: string): Promise<{ status: number; text: string }> {
    const host = service === "ses" ? `email.${this.#c.region}.amazonaws.com` : `sns.${this.#c.region}.amazonaws.com`;
    const headers = signV4({ method, host, path, body, service, region: this.#c.region, accessKeyId: this.#c.accessKeyId, secretAccessKey: this.#c.secretAccessKey, headers: body ? { "content-type": contentType } : {} });
    delete headers.host;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#endpoint ?? `https://${host}`}${path}`, { method, headers, body: body || undefined, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new AwsError(`Amazon ${service.toUpperCase()} didn't answer (${(err as Error).message})`, 503);
    }
    const text = await res.text();
    if (!res.ok) {
      let code = "";
      let message = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string; Message?: string; __type?: string };
        message = j.message ?? j.Message ?? message;
        code = (j.__type ?? res.headers.get("x-amzn-errortype") ?? "").split(":")[0]!;
      } catch {
        code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "";
        message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? message;
      }
      throw new AwsError(`Amazon ${service.toUpperCase()} answered ${res.status}${code ? ` ${code}` : ""}: ${message}`, res.status, code);
    }
    return { status: res.status, text };
  }

  async #ses<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.#call("ses", method, path, body === undefined ? "" : JSON.stringify(body), "application/json");
    return (r.text ? JSON.parse(r.text) : {}) as T;
  }

  async #sns(params: Record<string, string>): Promise<string> {
    const body = new URLSearchParams({ ...params, Version: "2010-03-31" }).toString();
    return (await this.#call("sns", "POST", "/", body, "application/x-www-form-urlencoded")).text;
  }

  /** The account: whether it can send, whether it's still in the sandbox, and its quota. */
  async account(): Promise<{ sendingEnabled: boolean; sandbox: boolean; maxPerSecond: number; max24h: number; sent24h: number }> {
    const a = await this.#ses<{ SendingEnabled?: boolean; ProductionAccessEnabled?: boolean; SendQuota?: { MaxSendRate?: number; Max24HourSend?: number; SentLast24Hours?: number } }>("GET", "/v2/email/account");
    return {
      sendingEnabled: a.SendingEnabled !== false,
      sandbox: a.ProductionAccessEnabled !== true,
      maxPerSecond: a.SendQuota?.MaxSendRate ?? 1,
      max24h: a.SendQuota?.Max24HourSend ?? 200,
      sent24h: a.SendQuota?.SentLast24Hours ?? 0,
    };
  }

  /** Sends a message as it is; returns SES's message id (what its events name). */
  async sendRaw(o: { from: string; to: string[]; raw: Buffer; configurationSet?: string | null }): Promise<string> {
    const r = await this.#ses<{ MessageId: string }>("POST", "/v2/email/outbound-emails", {
      FromEmailAddress: o.from,
      Destination: { ToAddresses: o.to },
      Content: { Raw: { Data: o.raw.toString("base64") } },
      ...(o.configurationSet ? { ConfigurationSetName: o.configurationSet } : {}),
    });
    return r.MessageId;
  }

  /** Starts a domain's verification (or reads it, when SES knows it already): its Easy DKIM tokens. */
  async createIdentity(domain: string): Promise<{ tokens: string[]; verified: boolean }> {
    try {
      const r = await this.#ses<{ VerifiedForSendingStatus?: boolean; DkimAttributes?: { Tokens?: string[] } }>("POST", "/v2/email/identities", { EmailIdentity: domain });
      return { tokens: r.DkimAttributes?.Tokens ?? [], verified: r.VerifiedForSendingStatus === true };
    } catch (err) {
      if (err instanceof AwsError && err.code === "AlreadyExistsException") return this.identity(domain);
      throw err;
    }
  }

  async identity(domain: string): Promise<{ tokens: string[]; verified: boolean; dkimStatus?: string }> {
    const r = await this.#ses<{ VerifiedForSendingStatus?: boolean; DkimAttributes?: { Tokens?: string[]; Status?: string } }>("GET", `/v2/email/identities/${encode(domain)}`);
    return { tokens: r.DkimAttributes?.Tokens ?? [], verified: r.VerifiedForSendingStatus === true, dkimStatus: r.DkimAttributes?.Status };
  }

  async deleteIdentity(domain: string): Promise<void> {
    await this.#ses("DELETE", `/v2/email/identities/${encode(domain)}`).catch((err: unknown) => {
      if (!(err instanceof AwsError && err.status === 404)) throw err;
    });
  }

  /**
   * Bounces, complaints and deliveries to `endpoint` (our /webhooks/ses): an
   * SNS topic, its HTTPS subscription (confirmed when SNS's first message
   * comes in), and a configuration set whose events go to the topic.
   */
  async setUpEvents(o: { name: string; endpoint: string }): Promise<{ configurationSet: string; topicArn: string }> {
    const created = await this.#sns({ Action: "CreateTopic", Name: o.name });
    const topicArn = /<TopicArn>([^<]+)<\/TopicArn>/.exec(created)?.[1];
    if (!topicArn) throw new AwsError("SNS didn't say which topic it made", 502);
    await this.#sns({ Action: "Subscribe", TopicArn: topicArn, Protocol: "https", Endpoint: o.endpoint, ReturnSubscriptionArn: "true" });
    await this.#ses("POST", "/v2/email/configuration-sets", { ConfigurationSetName: o.name }).catch((err: unknown) => {
      if (!(err instanceof AwsError && err.code === "AlreadyExistsException")) throw err;
    });
    await this.#ses("POST", `/v2/email/configuration-sets/${encode(o.name)}/event-destinations`, {
      EventDestinationName: "self-host-layer",
      EventDestination: { Enabled: true, MatchingEventTypes: ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT"], SnsDestination: { TopicArn: topicArn } },
    }).catch((err: unknown) => {
      if (!(err instanceof AwsError && err.code === "AlreadyExistsException")) throw err;
    });
    return { configurationSet: o.name, topicArn };
  }
}

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

// SNS's signing certificates, by URL: a few, rotated rarely.
const certs = new Map<string, string>();
const CERTS_MAX = 32;

/** The certificate's URL must be SNS's own, over HTTPS, and plain: no port, login, query or fragment to vary. */
export function snsCertUrlOk(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.port && !u.username && !u.password && !u.search && !u.hash && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname) && /^\/[\w.-]+\.pem$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** The text SNS signs, from the message's fields in its documented order. */
export function snsSignedText(m: SnsMessage): string {
  const keys = m.Type === "Notification" ? ["Message", "MessageId", ...(m.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"] : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys.map((k) => `${k}\n${(m as unknown as Record<string, string>)[k] ?? ""}\n`).join("");
}

/** Whether SNS signed this message (the certificate is fetched once per URL). */
export async function verifySns(m: SnsMessage, o: { fetch?: typeof fetch; certificate?: string } = {}): Promise<boolean> {
  if (!o.certificate && !snsCertUrlOk(m.SigningCertURL)) return false;
  const url = o.certificate ? "" : new URL(m.SigningCertURL).href;
  let pem = o.certificate ?? certs.get(url);
  if (!pem) {
    const res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    pem = await res.text();
    if (certs.size >= CERTS_MAX) certs.delete(certs.keys().next().value!);
    certs.set(url, pem);
  }
  try {
    const key = new X509Certificate(pem).publicKey;
    const v = createVerify(m.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1");
    v.update(snsSignedText(m), "utf8");
    return v.verify(key, m.Signature, "base64");
  } catch {
    return false;
  }
}
