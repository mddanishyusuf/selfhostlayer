/**
 * Runs mutating actions one at a time, so two calls can't race on the same
 * files, users or port allocation.
 */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * One Lock per key (an app's slug): the same app's builds, imports and
 * snapshots wait for each other; different apps' run side by side. The panel
 * decides how many apps build at once (Settings → Builds).
 */
export class KeyedLock {
  private locks = new Map<string, { lock: Lock; users: number }>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.locks.get(key);
    if (!entry) {
      entry = { lock: new Lock(), users: 0 };
      this.locks.set(key, entry);
    }
    const held = entry;
    held.users++;
    return held.lock.run(fn).finally(() => {
      if (--held.users === 0) this.locks.delete(key);
    });
  }
}
