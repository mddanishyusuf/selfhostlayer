import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
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
 * Append-only JSONL log of every call that changes the box, written before
 * the action runs and again when it ends. The file is root-only, so the panel
 * can't rewrite its own history. Past maxBytes it moves to <path>.1 (one
 * older file is kept).
 */
export class Audit {
  path: string;
  maxBytes: number;

  constructor(path: string, maxBytes = 10 * 2 ** 20) {
    this.path = path;
    this.maxBytes = maxBytes;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  write(entry: AuditEntry): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    try {
      if (statSync(this.path).size > this.maxBytes) renameSync(this.path, `${this.path}.1`);
    } catch {
      // no log yet
    }
    appendFileSync(this.path, line + "\n", { mode: 0o600 });
  }
}
