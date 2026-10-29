import { describe, expect, it } from "vitest";
import { inRange, inRanges, TAILSCALE_RANGES, validRange } from "./ip";

describe("inRange", () => {
  it("matches IPv4 addresses and ranges", () => {
    expect(inRange("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(inRange("203.0.113.8", "203.0.113.7")).toBe(false);
    expect(inRange("203.0.113.200", "203.0.113.0/24")).toBe(true);
    expect(inRange("203.0.114.1", "203.0.113.0/24")).toBe(false);
    expect(inRange("10.1.2.3", "0.0.0.0/0")).toBe(true);
    expect(inRange("::ffff:203.0.113.7", "203.0.113.0/24")).toBe(true);
  });

  it("matches IPv6, including :: and an IPv4 tail", () => {
    expect(inRange("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(inRange("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(inRange("fd7a:115c:a1e0:ab12::1", "fd7a:115c:a1e0::/48")).toBe(true);
    expect(inRange("64:ff9b::203.0.113.7", "64:ff9b::/96")).toBe(true);
    expect(inRange("::1", "::1")).toBe(true);
    expect(inRange("203.0.113.7", "2001:db8::/32")).toBe(false);
  });

  it("knows Tailscale's ranges", () => {
    expect(inRanges("100.101.102.103", TAILSCALE_RANGES)).toBe(true);
    expect(inRanges("100.128.0.1", TAILSCALE_RANGES)).toBe(false);
    expect(inRanges("192.168.1.10", TAILSCALE_RANGES)).toBe(false);
  });
});

describe("validRange", () => {
  it("takes IPs and CIDR ranges only", () => {
    for (const ok of ["1.2.3.4", "10.0.0.0/8", "2001:db8::/32", "::1"]) expect(validRange(ok), ok).toBe(true);
    for (const bad of ["10.0.0.0/33", "1.2.3.4/24/1", "example.com", "", "::/129", "1.2.3.4 5.6.7.8"]) expect(validRange(bad), bad).toBe(false);
  });
});
