import { describe, expect, it } from "vitest";
import { buildGeo, ipv6High } from "../geo-build.ts";
import { clientIp, Geo, isCloudflare } from "../geo.ts";
import { recentMonths } from "../geo-update.ts";
import { readAgent, referrerHost } from "../ua.ts";

describe("User-Agents and referrers", () => {
  const cases: [string, Partial<ReturnType<typeof readAgent>>][] = [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", { bot: false, device: "mobile", browser: "Safari", os: "iOS" }],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", { bot: false, device: "mobile", browser: "Chrome", os: "Android" }],
    ["Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", { device: "tablet", os: "Android" }],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", { bot: false, device: "desktop", browser: "Edge", os: "Windows" }],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0", { device: "desktop", browser: "Firefox", os: "macOS" }],
    ["Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36", { bot: false }],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", { bot: true }],
    ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", { bot: true }],
    ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", { bot: true }],
    ["WhatsApp/2.23.20.0", { bot: true }],
    ["curl/8.7.1", { bot: true }],
    // In-app browsers are people; the same apps' link-preview crawlers aren't.
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1", { bot: false, device: "mobile" }],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.50", { bot: false }],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 Telegram-Android/11.0", { bot: false }],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [Pinterest/iOS]", { bot: false }],
    ["LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)", { bot: true }],
    ["Twitterbot/1.0", { bot: true }],
    ["TelegramBot (like TwitterBot)", { bot: true }],
    ["Pinterest/0.2 (+http://www.pinterest.com/bot.html)", { bot: true }],
    ["", { bot: true, device: "other" }],
  ];
  it.each(cases)("%s", (ua, want) => expect(readAgent(ua)).toMatchObject(want));

  it("keeps the referring site's host, not this domain's", () => {
    expect(referrerHost("https://www.news.ycombinator.com/item?id=1", "go.example.com")).toBe("news.ycombinator.com");
    expect(referrerHost("https://go.example.com/launch", "go.example.com")).toBeNull();
    expect(referrerHost("not a url", "x")).toBeNull();
  });
});

describe("countries", () => {
  const CSV = [
    "0.0.0.0,0.255.255.255,ZZ",
    "1.0.0.0,1.0.0.255,AU",
    "1.0.1.0,1.0.3.255,CN",
    "1.0.4.0,1.0.7.255,CN",
    "81.2.69.0,81.2.69.255,GB",
    "81.2.70.0,255.255.255.255,US",
    "::,1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff,ZZ",
    "2001:4860::,2001:4860:ffff:ffff:ffff:ffff:ffff:ffff,US",
    "2001:4861::,2001:4861:0:0:ffff:ffff:ffff:ffff,DE",
    "2001:4861:0:1::,ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff,FR",
  ].join("\n");
  const geo = new Geo(buildGeo(CSV, "test-2026-10"));

  it("finds the country of an address, merging neighbours with the same one", () => {
    expect(geo.source).toBe("test-2026-10");
    expect(geo.country("1.0.0.7")).toBe("AU");
    expect(geo.country("1.0.5.1")).toBe("CN");
    expect(geo.country("81.2.69.160")).toBe("GB");
    expect(geo.country("::ffff:81.2.69.160")).toBe("GB");
    expect(geo.country("0.1.2.3")).toBeNull();
    expect(geo.country("2001:4860:4860::8888")).toBe("US");
    expect(geo.country("2001:4861::5")).toBe("DE");
    expect(geo.country("2001:4861:0:1::9")).toBe("FR");
    expect(geo.country("not an address")).toBeNull();
    expect(() => buildGeo("garbage", "x")).toThrow();
  });

  it("reads IPv6 in every spelling", () => {
    expect(ipv6High("2001:db8::1")).toBe(0x20010db800000000n);
    expect(ipv6High("::ffff:1.2.3.4")).toBe(0n);
    expect(ipv6High("1:2:3:4:5:6:7:8")).toBe(0x0001000200030004n);
    expect(ipv6High("1::2::3")).toBeNull();
  });

  it("believes CF-Connecting-IP only from Cloudflare's own addresses", () => {
    expect(isCloudflare("172.70.1.1")).toBe(true);
    expect(isCloudflare("2606:4700:10::1")).toBe(true);
    expect(isCloudflare("81.2.69.160")).toBe(false);
    const req = (h: Record<string, string>) => ({ headers: h, socket: { remoteAddress: "127.0.0.1" } }) as never;
    expect(clientIp(req({ "x-forwarded-for": "172.70.1.1", "cf-connecting-ip": "81.2.69.160" }))).toBe("81.2.69.160");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "81.2.69.160" }))).toBe("203.0.113.9");
    expect(clientIp(req({}))).toBe("127.0.0.1");
  });

  it("asks DB-IP for this month's list, then last month's", () => {
    expect(recentMonths(Date.UTC(2026, 0, 2))).toEqual(["2026-01", "2025-12"]);
  });
});
