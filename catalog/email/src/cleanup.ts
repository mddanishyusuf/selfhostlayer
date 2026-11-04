// Clean the list: Shield's address checks on a brand's subscribed and
// unconfirmed contacts not yet approved, 1,000 at a time by id, in the
// background. Progress and what it found are saved per batch (shield_scans,
// shield_hits), so a list of millions neither fills memory nor starts over
// after a restart. Apply then flags or unsubscribes the contacts of the
// checks picked, in batches too.
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import type { Contacts } from "./contacts.ts";
import { ADDRESS_CHECKS, type Check, type Shield } from "./shield.ts";

const BATCH = 1000;
const PAUSE_MS = 20;

export interface ScanView {
  state: "running" | "done" | "failed";
  checked: number;
  total: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  byCheck: Partial<Record<Check, number>>;
  examples: Partial<Record<Check, { email: string; detail: string }[]>>;
}

interface Row {
  brand_id: number;
  status: "running" | "done" | "failed";
  cursor: number;
  checked: number;
  total: number;
  by_check: string;
  examples: string;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export class Cleanup {
  readonly #db: DatabaseSync;
  readonly #shield: Shield;
  readonly #contacts: Contacts;
  readonly #background: boolean;
  readonly #running = new Map<number, Promise<void>>();

  constructor(o: { db: DatabaseSync; shield: Shield; contacts: Contacts; background?: boolean }) {
    this.#db = o.db;
    this.#shield = o.shield;
    this.#contacts = o.contacts;
    this.#background = o.background !== false;
  }

  view(brandId: number): ScanView | null {
    const r = this.#db.prepare("SELECT * FROM shield_scans WHERE brand_id = ?").get(brandId) as Row | undefined;
    if (!r) return null;
    return { state: r.status, checked: r.checked, total: r.total, startedAt: r.started_at, finishedAt: r.finished_at, error: r.error, byCheck: JSON.parse(r.by_check), examples: JSON.parse(r.examples) };
  }

  /** Starts a scan (or returns the one running), from the first contact. */
  start(brandId: number): ScanView {
    const now = this.view(brandId);
    if (now?.state === "running") return now;
    const total = (this.#db.prepare("SELECT count(*) n FROM contacts WHERE brand_id = ? AND status IN ('subscribed', 'unconfirmed') AND approved = 0").get(brandId) as { n: number }).n;
    this.#db.prepare("DELETE FROM shield_hits WHERE brand_id = ?").run(brandId);
    this.#db
      .prepare("INSERT INTO shield_scans (brand_id, status, cursor, checked, total, by_check, examples, error, started_at, finished_at) VALUES (?, 'running', 0, 0, ?, '{}', '{}', NULL, ?, NULL) ON CONFLICT (brand_id) DO UPDATE SET status = 'running', cursor = 0, checked = 0, total = excluded.total, by_check = '{}', examples = '{}', error = NULL, started_at = excluded.started_at, finished_at = NULL")
      .run(brandId, total, Date.now());
    if (this.#background) void this.run(brandId);
    return this.view(brandId)!;
  }

  /** At start: scans a restart cut short carry on from their last batch. */
  resume(): void {
    if (!this.#background) return;
    for (const r of this.#db.prepare("SELECT brand_id FROM shield_scans WHERE status = 'running'").all() as { brand_id: number }[]) void this.run(r.brand_id);
  }

  run(brandId: number): Promise<void> {
    const running = this.#running.get(brandId);
    if (running) return running;
    const p = this.#loop(brandId)
      .catch((err: Error) => {
        this.#db.prepare("UPDATE shield_scans SET status = 'failed', error = ?, finished_at = ? WHERE brand_id = ?").run(err.message.slice(0, 500), Date.now(), brandId);
      })
      .finally(() => this.#running.delete(brandId));
    this.#running.set(brandId, p);
    return p;
  }

  async #loop(brandId: number): Promise<void> {
    const settings = this.#shield.settings(brandId);
    for (;;) {
      const r = this.#db.prepare("SELECT * FROM shield_scans WHERE brand_id = ?").get(brandId) as Row | undefined;
      if (!r || r.status !== "running") return;
      const contacts = this.#db.prepare("SELECT id, email FROM contacts WHERE brand_id = ? AND id > ? AND status IN ('subscribed', 'unconfirmed') AND approved = 0 ORDER BY id LIMIT ?").all(brandId, r.cursor, BATCH) as { id: number; email: string }[];
      if (!contacts.length) {
        this.#db.prepare("UPDATE shield_scans SET status = 'done', finished_at = ? WHERE brand_id = ?").run(Date.now(), brandId);
        return;
      }
      const found = await this.#shield.checkMany(brandId, contacts.map((c) => c.email));
      const byCheck = JSON.parse(r.by_check) as Partial<Record<Check, number>>;
      const examples = JSON.parse(r.examples) as Partial<Record<Check, { email: string; detail: string }[]>>;
      const hit = this.#db.prepare("INSERT OR REPLACE INTO shield_hits (brand_id, contact_id, checks) VALUES (?, ?, ?)");
      this.#db.exec("BEGIN");
      try {
        for (const c of contacts) {
          const checks = (found.get(c.email.toLowerCase()) ?? []).filter((v) => settings.checks[v.check] !== "off");
          if (!checks.length) continue;
          hit.run(brandId, c.id, checks.map((v) => v.check).join(","));
          for (const v of checks) {
            byCheck[v.check] = (byCheck[v.check] ?? 0) + 1;
            const ex = (examples[v.check] ??= []);
            if (ex.length < 5) ex.push({ email: c.email, detail: v.detail });
          }
        }
        this.#db.prepare("UPDATE shield_scans SET cursor = ?, checked = checked + ?, by_check = ?, examples = ? WHERE brand_id = ?").run(contacts.at(-1)!.id, contacts.length, JSON.stringify(byCheck), JSON.stringify(examples), brandId);
        this.#db.exec("COMMIT");
      } catch (err) {
        this.#db.exec("ROLLBACK");
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  }

  /** Flags or unsubscribes the contacts the scan found for the checks picked, 1,000 at a time; the scan's results go. */
  apply(brandId: number, checks: unknown, action: "flag" | "unsubscribe"): number {
    if (this.view(brandId)?.state !== "done") throw new InputError("scan", "run Clean the list first, and wait for it to finish", 409);
    const picked = Array.isArray(checks) ? (checks.filter((c) => (ADDRESS_CHECKS as unknown[]).includes(c)) as Check[]) : [];
    if (!picked.length) throw new InputError("checks", "pick at least one check");
    let changed = 0;
    let after = 0;
    for (;;) {
      const rows = this.#db.prepare("SELECT contact_id, checks FROM shield_hits WHERE brand_id = ? AND contact_id > ? ORDER BY contact_id LIMIT ?").all(brandId, after, BATCH) as { contact_id: number; checks: string }[];
      if (!rows.length) break;
      after = rows.at(-1)!.contact_id;
      const batch = new Map<number, string[]>();
      for (const r of rows) {
        const mine = r.checks.split(",").filter((c) => picked.includes(c as Check));
        if (mine.length) batch.set(r.contact_id, mine);
      }
      if (batch.size) changed += this.#contacts.applyFlags(brandId, batch, action);
    }
    this.#db.prepare("DELETE FROM shield_hits WHERE brand_id = ?").run(brandId);
    this.#db.prepare("DELETE FROM shield_scans WHERE brand_id = ?").run(brandId);
    return changed;
  }
}
