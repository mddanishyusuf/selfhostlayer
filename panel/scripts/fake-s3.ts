// A tiny S3-compatible server for tests and the VM tour: path-style buckets,
// put/get/delete, ListObjectsV2 and multipart uploads, with every request's
// SigV4 signature checked. Objects live in memory.
//   node panel/scripts/fake-s3.ts [port]   (access key "test", secret "testsecret")
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { signV4 } from "../lib/backup/s3.ts";

export interface FakeS3 {
  server: Server;
  url: string;
  objects: Map<string, Buffer>;
  requests: string[];
  close: () => Promise<void>;
}

export const FAKE_KEY = { accessKeyId: "test", secretAccessKey: "testsecret" };

export function startFakeS3(port = 0): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Map<number, Buffer>>();
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const send = (status: number, xml = "", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/xml", ...headers });
      res.end(xml);
    };
    const error = (status: number, code: string, message: string) => send(status, `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);

    // Check the signature exactly as S3 would.
    const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
    if (!auth || auth[1] !== FAKE_KEY.accessKeyId) return error(403, "InvalidAccessKeyId", "unknown access key");
    const amzDate = String(req.headers["x-amz-date"]);
    const now = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
    const signed = Object.fromEntries(auth[4]!.split(";").filter((h) => !["host", "x-amz-date", "x-amz-content-sha256"].includes(h)).map((h) => [h, String(req.headers[h])]));
    const payloadHash = String(req.headers["x-amz-content-sha256"]);
    if (payloadHash !== createHash("sha256").update(body).digest("hex")) return error(400, "XAmzContentSHA256Mismatch", "body doesn't match its hash");
    const expected = signV4({ method: req.method!, url, headers: signed, payloadHash, ...FAKE_KEY, region: auth[3]!, now }).Authorization;
    if (expected !== req.headers.authorization) return error(403, "SignatureDoesNotMatch", "signature mismatch");

    const [, bucket, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    requests.push(`${req.method} ${key}${url.search}`);
    const id = `${bucket}/${key}`;
    const q = url.searchParams;

    if (req.method === "GET" && !key && q.get("list-type") === "2") {
      const prefix = `${bucket}/${q.get("prefix") ?? ""}`;
      const items = [...objects.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      const start = Number(q.get("continuation-token") ?? 0);
      const page = items.slice(start, start + 2); // tiny pages, so pagination is always exercised
      const next = start + 2 < items.length ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : "";
      return send(200, `<ListBucketResult><IsTruncated>${next ? "true" : "false"}</IsTruncated>${next}${page.map(([k, v]) => `<Contents><Key>${k.slice(bucket!.length + 1).replace(/&/g, "&amp;")}</Key><Size>${v.length}</Size><LastModified>2026-10-29T03:00:00.000Z</LastModified></Contents>`).join("")}</ListBucketResult>`);
    }
    if (req.method === "POST" && q.has("uploads")) {
      const uploadId = `up${uploads.size + 1}`;
      uploads.set(uploadId, new Map());
      return send(200, `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (req.method === "PUT" && q.has("uploadId")) {
      const parts = uploads.get(q.get("uploadId")!);
      if (!parts) return error(404, "NoSuchUpload", "no such upload");
      parts.set(Number(q.get("partNumber")), body);
      return send(200, "", { etag: `"${createHash("md5").update(body).digest("hex")}"` });
    }
    if (req.method === "POST" && q.has("uploadId")) {
      const parts = uploads.get(q.get("uploadId")!);
      if (!parts) return error(404, "NoSuchUpload", "no such upload");
      const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
      objects.set(id, Buffer.concat(numbers.map((n) => parts.get(n)!)));
      uploads.delete(q.get("uploadId")!);
      return send(200, "<CompleteMultipartUploadResult/>");
    }
    if (req.method === "DELETE" && q.has("uploadId")) {
      uploads.delete(q.get("uploadId")!);
      return send(204);
    }
    if (req.method === "PUT") {
      objects.set(id, body);
      return send(200);
    }
    if (req.method === "GET") {
      const obj = objects.get(id);
      if (!obj) return error(404, "NoSuchKey", "The specified key does not exist.");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": obj.length });
      return res.end(obj);
    }
    if (req.method === "DELETE") {
      objects.delete(id);
      return send(204);
    }
    error(400, "NotImplemented", `${req.method} isn't supported here`);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${address.port}`, objects, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s3 = await startFakeS3(Number(process.argv[2] ?? 4999));
  console.log(`fake S3 at ${s3.url} (access key ${FAKE_KEY.accessKeyId}, secret ${FAKE_KEY.secretAccessKey})`);
}
