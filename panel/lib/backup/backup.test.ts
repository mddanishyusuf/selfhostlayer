import { randomBytes } from "node:crypto";
import { Readable, Writable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_KEY, startFakeS3, type FakeS3 } from "../../scripts/fake-s3";
import { CHUNK, decryptStream, encryptStream, newRecoveryKey, parseRecoveryKey } from "./crypt";
import { PART_SIZE, S3, signV4 } from "./s3";

describe("signV4", () => {
  // The worked examples in AWS's "Signature Calculations for the Authorization
  // Header" docs (examplebucket, 2013-05-24).
  const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", now: new Date("2013-05-24T00:00:00Z") };
  const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  it("matches AWS's GET Object example", () => {
    const h = signV4({ ...creds, method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { range: "bytes=0-9" }, payloadHash: empty });
    expect(h.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("matches AWS's GET Bucket (list objects) example", () => {
    const h = signV4({ ...creds, method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"), headers: {}, payloadHash: empty });
    expect(h.Authorization).toMatch(/Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
  });
});

describe("backup encryption", () => {
  const key = parseRecoveryKey(newRecoveryKey());
  const run = async (data: Buffer, step: Transform) => {
    const out: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        out.push(chunk);
        cb();
      },
    });
    await pipeline(Readable.from([data]), step, sink);
    return Buffer.concat(out);
  };

  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 17])("round-trips %i bytes", async (n) => {
    const data = randomBytes(n);
    const sealed = await run(data, encryptStream(key));
    expect(sealed.length).toBe(40 + n + 16 * (Math.floor(n / CHUNK) + 1));
    expect((await run(sealed, decryptStream(key))).equals(data)).toBe(true);
  });

  it("rejects a wrong key, a changed byte and a cut-off end", async () => {
    const sealed = await run(randomBytes(2 * CHUNK + 5), encryptStream(key));
    await expect(run(sealed, decryptStream(parseRecoveryKey(newRecoveryKey())))).rejects.toThrow(/recovery key/);
    const flipped = Buffer.from(sealed);
    flipped[100]! ^= 1;
    await expect(run(flipped, decryptStream(key))).rejects.toThrow(/changed/);
    // Cut exactly at a chunk boundary: every remaining chunk is intact, but the last-chunk flag is missing.
    await expect(run(sealed.subarray(0, 40 + 2 * (CHUNK + 16)), decryptStream(key))).rejects.toThrow(/cut short/);
  });

  it("validates recovery keys", () => {
    expect(() => parseRecoveryKey("lbk1-short")).toThrow(/43/);
    expect(parseRecoveryKey(` ${newRecoveryKey()}\n`)).toHaveLength(32);
  });
});

describe("S3 client against a signature-checking fake", () => {
  let fake: FakeS3;
  let s3: S3;
  beforeAll(async () => {
    fake = await startFakeS3();
    s3 = new S3({ endpoint: fake.url, region: "auto", bucket: "backups", ...FAKE_KEY });
  });
  afterAll(() => fake.close());

  it("puts, gets, lists across pages and deletes, with awkward key names", async () => {
    const keys = ["srv/piqo/2026-10-29 03:00.tar.gz.enc", "srv/piqo/a+b&c.enc", "srv/blog/x.enc"];
    for (const k of keys) await s3.put(k, Buffer.from(k));
    expect(Buffer.from(await (await s3.get(keys[1]!)).arrayBuffer()).toString()).toBe(keys[1]);
    expect((await s3.list("srv/piqo/")).map((o) => o.key).sort()).toEqual([keys[0], keys[1]].sort());
    await s3.delete(keys[0]!);
    expect((await s3.list("srv/")).map((o) => o.key)).not.toContain(keys[0]);
  });

  it("uploads big streams in parts and small ones in one PUT", async () => {
    fake.requests.length = 0;
    const big = randomBytes(PART_SIZE * 2 + 1234);
    expect(await s3.upload("big.enc", Readable.from([big.subarray(0, 5_000_000), big.subarray(5_000_000)]))).toBe(big.length);
    expect(fake.objects.get("backups/big.enc")!.equals(big)).toBe(true);
    expect(fake.requests.filter((r) => r.startsWith("PUT big.enc?partNumber"))).toHaveLength(3);
    await s3.upload("small.enc", Readable.from([Buffer.from("hi")]));
    expect(fake.requests.at(-1)).toBe("PUT small.enc");
  });

  it("explains failures with the storage's error code", async () => {
    const wrong = new S3({ endpoint: fake.url, region: "auto", bucket: "backups", accessKeyId: "test", secretAccessKey: "nope" });
    await expect(wrong.put("x", Buffer.from("x"))).rejects.toThrow(/SignatureDoesNotMatch/);
    await expect(s3.get("missing")).rejects.toThrow(/NoSuchKey/);
  });
});

describe("tarGz", () => {
  it("writes an archive GNU/BSD tar can read", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { tarGz } = await import("./tar");
    const dir = mkdtempSync(join(tmpdir(), "layer-tar-"));
    writeFileSync(join(dir, "a.db"), randomBytes(1500));
    writeFileSync(join(dir, "key"), "secret\n");
    const out: Buffer[] = [];
    for await (const c of tarGz([{ name: "panel.db", path: join(dir, "a.db") }, { name: "secret.key", path: join(dir, "key") }])) out.push(c as Buffer);
    writeFileSync(join(dir, "x.tar.gz"), Buffer.concat(out));
    execFileSync("tar", ["-xzf", join(dir, "x.tar.gz"), "-C", dir]);
    expect(readFileSync(join(dir, "panel.db")).equals(readFileSync(join(dir, "a.db")))).toBe(true);
    expect(readFileSync(join(dir, "secret.key"), "utf8")).toBe("secret\n");
  });
});
