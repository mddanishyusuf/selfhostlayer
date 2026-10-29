import { describe, expect, it } from "vitest";
import { KeyedLock } from "../src/lock.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("KeyedLock", () => {
  it("runs different keys side by side and the same key one at a time", async () => {
    const lock = new KeyedLock();
    const events: string[] = [];
    const job = (name: string, ms: number) => async () => {
      events.push(`${name} start`);
      await sleep(ms);
      events.push(`${name} end`);
    };
    await Promise.all([lock.run("piqo", job("piqo-1", 30)), lock.run("blog", job("blog", 10)), lock.run("piqo", job("piqo-2", 5))]);
    // blog didn't wait for piqo; piqo-2 waited for piqo-1.
    expect(events.indexOf("blog start")).toBeLessThan(events.indexOf("piqo-1 end"));
    expect(events.indexOf("piqo-2 start")).toBeGreaterThan(events.indexOf("piqo-1 end"));
  });

  it("keeps going after a failure", async () => {
    const lock = new KeyedLock();
    await expect(lock.run("piqo", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await lock.run("piqo", async () => "next")).toBe("next");
  });
});
