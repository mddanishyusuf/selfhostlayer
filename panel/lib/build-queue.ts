// Deployments waiting for a build slot. Up to `limit()` run at once
// (Settings → Builds), never two of the same project; the rest start in the
// order they came, as soon as a slot frees up.
export class BuildQueue {
  readonly waiting: number[] = [];
  readonly running = new Set<number>();

  constructor(
    private readonly start: (id: number) => Promise<void>,
    private readonly projectOf: (id: number) => number | undefined,
    private readonly limit: () => number,
  ) {}

  add(id: number): void {
    if (!this.waiting.includes(id) && !this.running.has(id)) this.waiting.push(id);
    this.pump();
  }

  /** Takes out a deployment that hasn't started (cancelled while waiting). */
  remove(id: number): boolean {
    const i = this.waiting.indexOf(id);
    if (i < 0) return false;
    this.waiting.splice(i, 1);
    return true;
  }

  /** How many waiting deployments start before this one, or null if it isn't waiting. */
  position(id: number): number | null {
    const i = this.waiting.indexOf(id);
    return i < 0 ? null : i;
  }

  /** Starts waiting deployments while there are free slots. */
  pump(): void {
    while (this.running.size < Math.max(1, this.limit())) {
      const busy = new Set([...this.running].map(this.projectOf).filter((p) => p !== undefined));
      const i = this.waiting.findIndex((id) => {
        const project = this.projectOf(id);
        return project === undefined || !busy.has(project);
      });
      if (i < 0) return;
      const id = this.waiting.splice(i, 1)[0]!;
      this.running.add(id);
      void this.start(id)
        .catch((err) => console.error(`deployment ${id} crashed:`, err))
        .finally(() => {
          this.running.delete(id);
          this.pump();
        });
    }
  }
}

/**
 * A build's memory limit: 60% of its server's RAM shared by the builds that may
 * run at once, up to 4 GB, never under 1 GB or twice the app's own limit.
 * A flat 1 GB passed on servers with swap (a build may use 2 GB of it), but
 * killed every Next.js build on an 8 GB server, which the installer gives none.
 */
export function buildMemoryFor(appMb: number, serverMb: number | undefined, slots: number): number {
  const share = serverMb ? Math.min(4096, Math.floor((serverMb * 0.6) / slots)) : 0;
  return Math.max(1024, appMb * 2, share);
}
