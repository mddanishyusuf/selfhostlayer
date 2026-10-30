import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A fresh database; the fake agent's feed offers 0.2.0 to a server on "dev".
process.env.LAYER_DB = join(mkdtempSync(join(tmpdir(), "layer-updates-")), "panel.db");
process.env.LAYER_FAKE_AGENT = "1";
const { autoCheck, checkForUpdates, offeredUpdate, setAutoCheck, updateState } = await import("./updates");

const latest = { version: "0.2.0", date: "2026-11-02", notes: null };

describe("offeredUpdate", () => {
  it("offers a newer release found from this version", () => {
    expect(offeredUpdate({ checkedAt: 1, error: null, current: "0.1.0", latest, available: true }, "0.1.0")).toEqual(latest);
  });

  it("drops an answer from before an update, and keeps it through a failed check", () => {
    expect(offeredUpdate({ checkedAt: 1, error: null, current: "0.1.0", latest, available: true }, "0.2.0")).toBeNull();
    expect(offeredUpdate({ checkedAt: 2, error: "couldn't reach the update feed", current: "0.1.0", latest, available: true }, "0.1.0")).toEqual(latest);
    expect(offeredUpdate({ checkedAt: 1, error: null, current: "0.2.0", latest, available: false }, "0.2.0")).toBeNull();
    expect(offeredUpdate(null, "0.1.0")).toBeNull();
  });
});

describe("checkForUpdates", () => {
  it("keeps the answer for every page", async () => {
    expect(updateState()).toBeNull();
    const state = await checkForUpdates();
    expect(state).toMatchObject({ error: null, current: "dev", available: true, latest: { version: "0.2.0" } });
    expect(updateState()).toEqual(state);
    expect(offeredUpdate(updateState(), "dev")?.version).toBe("0.2.0");
  });

  it("checks automatically unless turned off", () => {
    expect(autoCheck()).toBe(true);
    setAutoCheck(false);
    expect(autoCheck()).toBe(false);
    setAutoCheck(true);
    expect(autoCheck()).toBe(true);
  });
});
