import { describe, expect, it } from "vitest";
import { cronToCalendar, describeCron } from "./cron";

describe("cronToCalendar", () => {
  it.each([
    ["* * * * *", "*-*-* *:*:00"],
    ["*/15 * * * *", "*-*-* *:00/15:00"],
    ["0 * * * *", "*-*-* *:00:00"],
    ["30 3 * * *", "*-*-* 03:30:00"],
    ["0 9-17 * * *", "*-*-* 09..17:00:00"],
    ["0 9-17/2 * * *", "*-*-* 09..17/2:00:00"],
    ["0,30 * * * *", "*-*-* *:00,30:00"],
    ["0 0 1 * *", "*-*-01 00:00:00"],
    ["0 0 1 jan *", "*-01-01 00:00:00"],
    ["0 8 * * 1-5", "Mon..Fri *-*-* 08:00:00"],
    ["0 8 * * mon,wed,fri", "Mon,Wed,Fri *-*-* 08:00:00"],
    ["0 10 * * 0", "Sun *-*-* 10:00:00"],
    ["0 10 * * 7", "Sun *-*-* 10:00:00"],
    ["@daily", "daily"],
    ["@hourly", "hourly"],
    ["@weekly", "weekly"],
  ])("%s → %s", (cron, calendar) => {
    expect(cronToCalendar(cron)).toBe(calendar);
  });

  it.each([
    ["* * * *", /5 fields/],
    ["60 * * * *", /minute/],
    ["* 24 * * *", /hour/],
    ["0 0 1 * 1", /either the day of month or the day of week/],
    ["*/0 * * * *", /step/],
    ["5-1 * * * *", /backwards/],
    ["0 0 * * */2", /Steps/],
    ["0 0 * * * ; rm -rf /", /5 fields|allowed/],
    ["0 0 * * $(id)", /allowed/],
  ])("rejects %s", (cron, error) => {
    expect(() => cronToCalendar(cron)).toThrow(error);
  });
});

describe("describeCron", () => {
  it("describes the common shapes", () => {
    expect(describeCron("*/5 * * * *")).toBe("every 5 minutes");
    expect(describeCron("0 3 * * *")).toBe("every day at 03:00");
    expect(describeCron("15 * * * *")).toBe("every hour at :15");
    expect(describeCron("@daily")).toBe("every day at 00:00");
    expect(describeCron("0 8 * * 1-5")).toBe("0 8 * * 1-5");
  });
});
