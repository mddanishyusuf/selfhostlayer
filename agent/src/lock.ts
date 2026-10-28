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
