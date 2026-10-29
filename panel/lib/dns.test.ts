import { describe, expect, it } from "vitest";
import { canGoLive, evaluateDns, explainDns, isCloudflareIp, suggestedRecord, type DnsAnswers, type DnsVerdict } from "./dns";

const IP = "37.27.25.45";
const ans = (a: string[], aaaa: string[] = []): DnsAnswers => ({ a, aaaa, cname: [] });

describe("evaluateDns", () => {
  it("is ok only when every resolver points every A record here and no AAAA points elsewhere", () => {
    expect(evaluateDns([ans([IP]), ans([IP])], IP)).toEqual({ status: "ok" });
  });

  it("reports a missing record", () => {
    expect(evaluateDns([ans([]), ans([])], IP)).toEqual({ status: "none" });
  });

  it("reports a wrong IP, including one wrong record among several", () => {
    expect(evaluateDns([ans(["1.2.3.4"]), ans(["1.2.3.4"])], IP)).toEqual({ status: "wrong_ip", found: ["1.2.3.4"] });
    expect(evaluateDns([ans([IP, "5.6.7.8"]), ans([IP, "5.6.7.8"])], IP).status).toBe("wrong_ip");
  });

  it("recognizes Cloudflare's proxy", () => {
    expect(evaluateDns([ans(["104.21.32.1"]), ans(["104.21.32.1"])], IP)).toMatchObject({ status: "cloudflare" });
  });

  it("catches an AAAA record that points elsewhere", () => {
    expect(evaluateDns([ans([IP], ["2606:4700::1"]), ans([IP], ["2606:4700::1"])], IP)).toEqual({ status: "ipv6_mismatch", found: ["2606:4700::1"] });
  });

  it("waits while resolvers disagree (a change still spreading)", () => {
    expect(evaluateDns([ans([IP]), ans(["1.2.3.4"])], IP)).toEqual({ status: "resolvers_disagree" });
  });

  it("explains every verdict with a fix", () => {
    const verdicts: DnsVerdict[] = [{ status: "none" }, { status: "wrong_ip", found: ["1.2.3.4"] }, { status: "cloudflare", found: ["104.21.0.1"] }, { status: "ipv6_mismatch", found: ["::1"] }, { status: "resolvers_disagree" }];
    for (const v of verdicts) {
      expect(explainDns(v, "piqo.app", IP).length).toBeGreaterThan(20);
    }
    expect(explainDns({ status: "cloudflare", found: [] }, "piqo.app", IP)).toMatch(/Keep the proxy, or set the record to "DNS only"/);
  });
});

describe("isCloudflareIp", () => {
  it("matches Cloudflare ranges only", () => {
    for (const ip of ["104.16.0.1", "172.67.1.1", "188.114.97.3", "162.159.1.1"]) expect(isCloudflareIp(ip)).toBe(true);
    for (const ip of [IP, "8.8.8.8", "1.1.1.1", "not-an-ip"]) expect(isCloudflareIp(ip)).toBe(false);
  });
});

describe("suggestedRecord", () => {
  it("always asks for an A record to this server, named relative to the bought domain", () => {
    expect(suggestedRecord("piqo.app", IP)).toEqual({ type: "A", name: "@", value: IP });
    expect(suggestedRecord("www.reducepngsize.com", IP)).toEqual({ type: "A", name: "www", value: IP });
    // Three short labels used to pass for example.co.uk.
    expect(suggestedRecord("www.abc.com", IP)).toEqual({ type: "A", name: "www", value: IP });
    expect(suggestedRecord("example.co.uk", IP)).toEqual({ type: "A", name: "@", value: IP });
    expect(suggestedRecord("shop.example.co.uk", IP)).toEqual({ type: "A", name: "shop", value: IP });
    expect(suggestedRecord("app.staging.piqo.app", IP)).toEqual({ type: "A", name: "app.staging", value: IP });
  });
});

describe("canGoLive", () => {
  it("needs DNS pointing here, or Cloudflare's proxy kept on purpose", () => {
    expect(canGoLive("ok", false)).toBe(true);
    expect(canGoLive("cloudflare", false)).toBe(false);
    expect(canGoLive("cloudflare", true)).toBe(true);
    for (const status of ["none", "wrong_ip", "ipv6_mismatch", "resolvers_disagree"] as const) expect(canGoLive(status, true)).toBe(false);
  });
});
