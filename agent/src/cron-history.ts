// Cron run history from the journal (journalctl -o json for one service).
// systemd's own messages carry the run's INVOCATION_ID; the job's output lines
// usually carry it too (_SYSTEMD_INVOCATION_ID), but a process that exits
// quickly can lose it, so unmatched lines are placed by timestamp.

const STARTED = "39f53479d3a045ac8e11786248231fbf";
const SUCCEEDED = "7ad2d189f7e94e70a38c781354912448";
const FAILED = "d9b373ed55a64feb8242e02dbe79a49c";
const EXITED = "98e322203f7a4ed290d09fe03c09fe15";

export interface JournalEntry {
  __REALTIME_TIMESTAMP: string;
  MESSAGE?: string | number[];
  MESSAGE_ID?: string;
  INVOCATION_ID?: string;
  _SYSTEMD_INVOCATION_ID?: string;
  EXIT_STATUS?: string;
  _PID?: string;
}

export interface CronRun {
  invocation: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failed";
  exitStatus: number | null;
  output: string[];
}

const MAX_OUTPUT_LINES = 200;

const text = (m: JournalEntry["MESSAGE"]) => (Array.isArray(m) ? Buffer.from(m).toString("utf8") : (m ?? ""));

export function parseCronHistory(entries: JournalEntry[], limit = 20): CronRun[] {
  const runs = new Map<string, CronRun & { startUs: number; endUs: number }>();
  const loose: JournalEntry[] = [];
  for (const e of entries) {
    const us = Number(e.__REALTIME_TIMESTAMP);
    const iso = new Date(us / 1000).toISOString();
    if (e.MESSAGE_ID && e.INVOCATION_ID) {
      let run = runs.get(e.INVOCATION_ID);
      if (!run) {
        run = { invocation: e.INVOCATION_ID, startedAt: iso, finishedAt: null, status: "running", exitStatus: null, output: [], startUs: us, endUs: Infinity };
        runs.set(e.INVOCATION_ID, run);
      }
      if (e.MESSAGE_ID === STARTED) {
        run.startedAt = iso;
        run.startUs = us;
      } else if (e.MESSAGE_ID === EXITED) {
        run.exitStatus = e.EXIT_STATUS !== undefined ? Number(e.EXIT_STATUS) : null;
      } else if (e.MESSAGE_ID === SUCCEEDED || e.MESSAGE_ID === FAILED) {
        run.status = e.MESSAGE_ID === SUCCEEDED ? "success" : "failed";
        run.finishedAt = iso;
        run.endUs = us;
        if (run.status === "success" && run.exitStatus === null) run.exitStatus = 0;
      }
    } else if (!e.MESSAGE_ID) {
      loose.push(e);
    }
  }
  for (const e of loose) {
    const us = Number(e.__REALTIME_TIMESTAMP);
    const run =
      (e._SYSTEMD_INVOCATION_ID && runs.get(e._SYSTEMD_INVOCATION_ID)) ||
      [...runs.values()].find((r) => us >= r.startUs && us <= r.endUs);
    if (run) run.output.push(text(e.MESSAGE));
  }
  return [...runs.values()]
    .sort((a, b) => b.startUs - a.startUs)
    .slice(0, limit)
    .map(({ startUs: _s, endUs: _e, ...run }) => ({ ...run, output: run.output.slice(-MAX_OUTPUT_LINES) }));
}
