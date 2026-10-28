import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  id: string;
  action: string;
  phase: "start" | "end";
  params?: unknown;
  ok?: boolean;
  code?: string;
  ms?: number;
}

/**
 * Append-only JSONL log of every privileged call, written before the action
 * runs and again when it ends. The file is root-only, so the panel can't
 * rewrite its own history.
 */
export class Audit {
  path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  write(entry: AuditEntry): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(this.path, line + "\n", { mode: 0o600 });
  }
}
