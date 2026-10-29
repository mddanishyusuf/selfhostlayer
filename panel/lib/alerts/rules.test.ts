import { describe, expect, it } from "vitest";
import { certVerdict, crashVerdict, cronVerdict, diskVerdict } from "./rules";

describe("diskVerdict", () => {
  it("alerts at 80% and recovers below 75%, without flapping in between", () => {
    expect(diskVerdict(0.79, false)).toBe("unchanged");
    expect(diskVerdict(0.8, false)).toBe("alert");
    expect(diskVerdict(0.78, true)).toBe("unchanged");
    expect(diskVerdict(0.74, true)).toBe("recover");
    expect(diskVerdict(0.95, true)).toBe("unchanged");
  });
});

describe("crashVerdict", () => {
  it("alerts when systemd gave up, or after 3+ restarts since the last check", () => {
    expect(crashVerdict(null, { state: "failed", restarts: 0 }, false)).toBe("alert");
    expect(crashVerdict({ state: "active", restarts: 1 }, { state: "activating", restarts: 4 }, false)).toBe("alert");
    expect(crashVerdict({ state: "active", restarts: 1 }, { state: "active", restarts: 2 }, false)).toBe("unchanged");
    expect(crashVerdict(null, { state: "active", restarts: 50 }, false)).toBe("unchanged");
  });

  it("recovers once it's active with no new restarts", () => {
    expect(crashVerdict({ state: "activating", restarts: 9 }, { state: "active", restarts: 9 }, true)).toBe("recover");
    expect(crashVerdict({ state: "activating", restarts: 9 }, { state: "active", restarts: 10 }, true)).toBe("unchanged");
  });
});

describe("certVerdict", () => {
  it("alerts on expired, unreachable, renewal overdue, or stuck issuing past 15 minutes", () => {
    expect(certVerdict({ ok: false, reason: "expired" }, 0, false)).toBe("alert");
    expect(certVerdict({ ok: false, reason: "unreachable" }, 0, false)).toBe("alert");
    expect(certVerdict({ ok: true, daysLeft: 10 }, 0, false)).toBe("alert");
    expect(certVerdict({ ok: false, reason: "issuing" }, 60, false)).toBe("unchanged");
    expect(certVerdict({ ok: false, reason: "issuing" }, 16 * 60, false)).toBe("alert");
  });

  it("never alerts on a local CA, and recovers on a healthy certificate", () => {
    expect(certVerdict({ ok: false, reason: "untrusted" }, 99_999, false)).toBe("unchanged");
    expect(certVerdict({ ok: true, daysLeft: 89 }, 0, true)).toBe("recover");
    expect(certVerdict({ ok: true, daysLeft: 89 }, 0, false)).toBe("unchanged");
  });
});

describe("cronVerdict", () => {
  it("alerts on a failed last run and recovers on a successful one", () => {
    expect(cronVerdict("exit-code", "Thu 2026-10-29 08:30:00 UTC", false)).toBe("alert");
    expect(cronVerdict("success", "Thu 2026-10-29 09:00:00 UTC", true)).toBe("recover");
    expect(cronVerdict("success", "Thu 2026-10-29 09:00:00 UTC", false)).toBe("unchanged");
    expect(cronVerdict(null, null, false)).toBe("unchanged");
  });
});
