import { describe, expect, it } from "vitest";
import { BuildQueue } from "./build-queue";

/** A queue whose builds finish when the test says so. */
function setup(limit: number, projects: Record<number, number>) {
  const started: number[] = [];
  const finishers = new Map<number, () => void>();
  let slots = limit;
  const queue = new BuildQueue(
    (id) =>
      new Promise<void>((resolve) => {
        started.push(id);
        finishers.set(id, resolve);
      }),
    (id) => projects[id],
    () => slots,
  );
  const finish = async (id: number) => {
    finishers.get(id)!();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { queue, started, finish, setSlots: (n: number) => (slots = n) };
}

describe("BuildQueue", () => {
  it("runs up to the limit at once, and starts the next as one finishes", async () => {
    const { queue, started, finish } = setup(2, { 1: 10, 2: 20, 3: 30 });
    queue.add(1);
    queue.add(2);
    queue.add(3);
    expect(started).toEqual([1, 2]);
    expect(queue.position(3)).toBe(0);
    await finish(1);
    expect(started).toEqual([1, 2, 3]);
    expect(queue.position(3)).toBeNull();
  });

  it("never runs two deployments of one project at once, letting others go first", async () => {
    const { queue, started, finish } = setup(2, { 1: 10, 2: 10, 3: 30 });
    queue.add(1);
    queue.add(2); // same project as 1: waits
    queue.add(3); // another project: takes the free slot
    expect(started).toEqual([1, 3]);
    await finish(1);
    expect(started).toEqual([1, 3, 2]);
  });

  it("with one slot, goes one at a time in order", async () => {
    const { queue, started, finish } = setup(1, { 1: 10, 2: 20 });
    queue.add(1);
    queue.add(2);
    expect(started).toEqual([1]);
    await finish(1);
    expect(started).toEqual([1, 2]);
  });

  it("starts waiting ones when the limit goes up, and drops cancelled ones", async () => {
    const { queue, started, setSlots } = setup(1, { 1: 10, 2: 20, 3: 30 });
    queue.add(1);
    queue.add(2);
    queue.add(3);
    expect(queue.remove(2)).toBe(true);
    setSlots(3);
    queue.pump();
    expect(started).toEqual([1, 3]);
  });
});
