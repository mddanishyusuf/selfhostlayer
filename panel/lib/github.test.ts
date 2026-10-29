import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appJwt, buildManifest, convertManifest, listInstallationRepos, manifestFormAction, setWebhookUrl, verifyWebhookSignature } from "./github";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const app = { appId: 1, clientId: "Iv23liTEST", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };

describe("buildManifest", () => {
  it("points every callback at this panel and asks for minimal permissions", () => {
    const m = buildManifest("https://37-27-25-45.sslip.io", "Self Host Layer (37-27-25-45)");
    expect(m.redirect_url).toBe("https://37-27-25-45.sslip.io/api/github/manifest");
    expect(m.setup_url).toBe("https://37-27-25-45.sslip.io/api/github/installed");
    expect(m.hook_attributes.url).toBe("https://37-27-25-45.sslip.io/api/github/webhook");
    expect(m.default_permissions).toEqual({ contents: "read", metadata: "read", statuses: "write" });
    expect(m.public).toBe(false);
  });

  it("posts to the user's account or an organization", () => {
    expect(manifestFormAction("st ate")).toBe("https://github.com/settings/apps/new?state=st%20ate");
    expect(manifestFormAction("s", "acme-inc")).toBe("https://github.com/organizations/acme-inc/settings/apps/new?state=s");
  });
});

describe("appJwt", () => {
  it("is an RS256 JWT GitHub accepts: iss = client id, 10 minutes max, signed with the app key", () => {
    const jwt = appJwt(app, 1_700_000_000);
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(payload).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: "Iv23liTEST" });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });
});

describe("verifyWebhookSignature", () => {
  const body = '{"zen":"Keep it logically awesome."}';
  const sign = (secret: string, b: string) => `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`;

  it("accepts the right signature only", () => {
    expect(verifyWebhookSignature("s3cret", body, sign("s3cret", body))).toBe(true);
    expect(verifyWebhookSignature("s3cret", body, sign("other", body))).toBe(false);
    expect(verifyWebhookSignature("s3cret", body + " ", sign("s3cret", body))).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, null)).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, "sha1=abc")).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, "sha256=short")).toBe(false);
  });
});

describe("API calls", () => {
  it("rejects malformed manifest codes before calling GitHub", async () => {
    await expect(convertManifest("../x")).rejects.toThrow(/bad manifest code/);
  });

  it("lists every page of repositories with a metadata-only token", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "ghs_x", expires_at: "2030-01-01T00:00:00Z" });
      const page = Number(new URL(url).searchParams.get("page"));
      const repos = Array.from({ length: page === 1 ? 100 : 20 }, (_, i) => ({ id: page * 1000 + i, name: `r${page}-${i}` }));
      return Response.json({ total_count: 120, repositories: repos });
    }) as typeof fetch;
    const repos = await listInstallationRepos(app, 42, fake);
    expect(repos).toHaveLength(120);
    expect(calls[0]!.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ permissions: { metadata: "read" } });
    expect(calls.filter((c) => c.url.includes("/installation/repositories"))).toHaveLength(2);
  });

  it("points the webhook at the panel's new address, as the app", async () => {
    let call: { url: string; init?: RequestInit } | undefined;
    const fake = (async (url: string, init?: RequestInit) => {
      call = { url, init };
      return Response.json({ url: "https://panel.example.com/api/github/webhook", content_type: "json" });
    }) as typeof fetch;
    await setWebhookUrl(app, "https://panel.example.com/api/github/webhook", fake);
    expect(call!.url).toBe("https://api.github.com/app/hook/config");
    expect(call!.init!.method).toBe("PATCH");
    expect(JSON.parse(call!.init!.body as string)).toEqual({ url: "https://panel.example.com/api/github/webhook" });
    expect(String((call!.init!.headers as Record<string, string>).Authorization)).toMatch(/^Bearer ey/);
  });
});
