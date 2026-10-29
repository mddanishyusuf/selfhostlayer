// A small S3 client: just what backups need (put, get, delete, list,
// multipart upload), signed with AWS Signature V4. Works with AWS S3,
// Cloudflare R2, Backblaze B2, Hetzner Object Storage, Wasabi and MinIO.
// No SDK: node:crypto and fetch.
import { createHash, createHmac } from "node:crypto";
import type { Readable } from "node:stream";

export interface S3Config {
  /** https://<account>.r2.cloudflarestorage.com, https://s3.eu-central-003.backblazeb2.com, … */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Parts are buffered in memory: 16MB keeps a 1GB box comfortable and allows backups up to 160GB (10,000 parts). */
export const PART_SIZE = 16 * 1024 * 1024;

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();
const hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** RFC 3986 encoding as S3 wants it: everything but unreserved characters. */
export function uriEncode(value: string, keepSlash = false): string {
  return [...Buffer.from(value, "utf8")]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** For tests: the signing time. */
  now?: Date;
}

/**
 * AWS Signature V4 for S3. Returns the headers to send: the given ones plus
 * x-amz-date, x-amz-content-sha256 and Authorization.
 */
export function signV4(input: SignInput): Record<string, string> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, host: input.url.host, "x-amz-date": amzDate, "x-amz-content-sha256": input.payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const query = input.url.search
    .slice(1)
    .split("&")
    .filter(Boolean)
    .map((pair) => pair.split("=").map((part) => uriEncode(decodeURIComponent(part))) as [string, string])
    .map(([k, v = ""]) => [k, v] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    input.method,
    // The URL's pathname is already percent-encoded once (by uriEncode when it was built).
    input.url.pathname || "/",
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    names.join(";"),
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  delete headers.host;
  return { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

export class S3Error extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "S3Error";
    this.status = status;
    this.code = code;
  }
}

const xmlValue = (xml: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
const xmlUnescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export class S3 {
  private config: S3Config;
  private fetchImpl: typeof fetch;

  constructor(config: S3Config, fetchImpl: typeof fetch = fetch) {
    this.config = { ...config, endpoint: config.endpoint.replace(/\/+$/, "") };
    this.fetchImpl = fetchImpl;
  }

  /** Path-style URLs (endpoint/bucket/key): every provider above supports them, and bucket names with dots keep working with TLS. */
  url(key: string, query: Record<string, string> = {}): URL {
    const url = new URL(`${this.config.endpoint}/${uriEncode(this.config.bucket)}/${uriEncode(key, true)}`);
    // Encoded by hand: URLSearchParams writes spaces as "+", which S3 would sign differently.
    url.search = Object.entries(query).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
    return url;
  }

  private async request(method: string, key: string, opts: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string> } = {}): Promise<Response> {
    const url = this.url(key, opts.query);
    const body = opts.body;
    const headers = signV4({
      method,
      url,
      headers: { ...(opts.headers ?? {}) },
      payloadHash: body ? hex(body) : EMPTY_SHA256,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: this.config.region,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      throw new S3Error(0, "network", `can't reach ${url.host}: ${(err as Error).cause ? String((err as { cause: unknown }).cause) : (err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const code = xmlValue(text, "Code") ?? `HTTP${res.status}`;
      const message = xmlValue(text, "Message") ?? text.slice(0, 200);
      throw new S3Error(res.status, code, `${method} ${key || "/"}: ${code}${message ? ` (${xmlUnescape(message)})` : ""}`);
    }
    return res;
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.request("PUT", key, { body });
  }

  async get(key: string): Promise<Response> {
    return this.request("GET", key);
  }

  async delete(key: string): Promise<void> {
    await this.request("DELETE", key);
  }

  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const xml = await (await this.request("GET", "", { query })).text();
      for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        out.push({ key: xmlUnescape(xmlValue(item!, "Key") ?? ""), size: Number(xmlValue(item!, "Size") ?? 0), lastModified: xmlValue(item!, "LastModified") ?? "" });
      }
      token = xmlValue(xml, "IsTruncated") === "true" ? xmlUnescape(xmlValue(xml, "NextContinuationToken") ?? "") : undefined;
    } while (token);
    return out;
  }

  /**
   * Uploads a stream: one PUT when it fits in a part, multipart otherwise
   * (aborted on failure, so no orphaned parts are billed). Returns the bytes sent.
   */
  async upload(key: string, stream: Readable): Promise<number> {
    let buffered: Buffer[] = [];
    let size = 0;
    let total = 0;
    let uploadId: string | null = null;
    const parts: string[] = [];

    /** Sends the first PART_SIZE buffered bytes (or all of them, for the last part). */
    const flushPart = async () => {
      const all = Buffer.concat(buffered);
      const body = all.subarray(0, PART_SIZE);
      const rest = all.subarray(body.length);
      buffered = rest.length ? [rest] : [];
      size = rest.length;
      if (!uploadId) {
        const xml = await (await this.request("POST", key, { query: { uploads: "" } })).text();
        uploadId = xmlValue(xml, "UploadId") ?? null;
        if (!uploadId) throw new S3Error(0, "bad_response", "the storage didn't return an upload id");
      }
      const res = await this.request("PUT", key, { query: { partNumber: String(parts.length + 1), uploadId }, body });
      parts.push(res.headers.get("etag") ?? "");
    };

    try {
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        buffered.push(buf);
        size += buf.length;
        total += buf.length;
        while (size >= PART_SIZE) await flushPart();
      }
      if (!uploadId) {
        await this.put(key, Buffer.concat(buffered));
        return total;
      }
      while (size > 0) await flushPart();
      const xml = `<CompleteMultipartUpload>${parts.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      const res = await this.request("POST", key, { query: { uploadId }, body: Buffer.from(xml) });
      // S3 can answer 200 with an error in the body.
      const text = await res.text();
      if (text.includes("<Error>")) throw new S3Error(200, xmlValue(text, "Code") ?? "Error", `completing the upload failed: ${xmlValue(text, "Message") ?? text.slice(0, 200)}`);
      return total;
    } catch (err) {
      if (uploadId) await this.request("DELETE", key, { query: { uploadId } }).catch(() => {});
      throw err;
    }
  }
}
