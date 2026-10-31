// A site's goals: reaching a page (with * for any characters: /blog/*) or
// sending a custom event (Signup). Each counts the visitors who reached it in
// a range, what share of all visitors that is, and the revenue from the visits
// that reached it.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import { mainCurrency } from "./revenue.ts";
import { type Filters, type Range, visitFilters, windowOf } from "./stats.ts";

export interface Goal {
  id: number;
  siteId: number;
  name: string;
  kind: "page" | "event";
  /** The page's path (with * wildcards), or the event's name. */
  value: string;
  createdAt: number;
}

export interface GoalStats extends Goal {
  visitors: number;
  visits: number;
  /** Visitors who reached it, of all visitors in the range (0 to 1). */
  rate: number;
  /** In the site's main currency's smallest unit. */
  revenue: number;
}

interface Row {
  id: number;
  site_id: number;
  name: string;
  kind: "page" | "event";
  value: string;
  created_at: number;
}

const fromRow = (r: Row): Goal => ({ id: r.id, siteId: r.site_id, name: r.name, kind: r.kind, value: r.value, createdAt: r.created_at });

export const MAX_GOALS = 50;
const EVENT = /^[\p{L}\p{N} _.:/-]{1,60}$/u;

/** The goal's fields, checked; what's missing comes from the goal it changes. */
function checked(input: Record<string, unknown>, was?: Goal): Pick<Goal, "name" | "kind" | "value"> {
  const kind = input.kind ?? was?.kind;
  if (kind !== "page" && kind !== "event") throw new InputError("kind", "must be page or event");
  const value = typeof input.value === "string" ? input.value.trim() : was?.value;
  if (kind === "page" && (!value || !value.startsWith("/") || value.length > 500 || /[\s\u0000-\u001f]/.test(value))) {
    throw new InputError("value", "must be a path like /pricing, with * for any characters (/blog/*)");
  }
  if (kind === "event" && (!value || !EVENT.test(value))) throw new InputError("value", "must be an event's name, like Signup");
  const name = typeof input.name === "string" ? input.name.trim() || value : (was?.name ?? value);
  if (!name || name.length > 60 || /[\u0000-\u001f]/.test(name)) throw new InputError("name", "must be up to 60 characters");
  return { name, kind, value: value! };
}

export function listGoals(db: DatabaseSync, siteId: number): Goal[] {
  return (db.prepare("SELECT * FROM goals WHERE site_id = ? ORDER BY id").all(siteId) as unknown as Row[]).map(fromRow);
}

export function getGoal(db: DatabaseSync, id: number): Goal | null {
  const row = db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

export function addGoal(db: DatabaseSync, siteId: number, input: Record<string, unknown>): Goal {
  if (listGoals(db, siteId).length >= MAX_GOALS) throw new InputError("goals", `a site has up to ${MAX_GOALS} goals`, 409);
  const g = checked(input);
  const createdAt = Date.now();
  const id = Number(db.prepare("INSERT INTO goals (site_id, name, kind, value, created_at) VALUES (?, ?, ?, ?, ?)").run(siteId, g.name, g.kind, g.value, createdAt).lastInsertRowid);
  return { id, siteId, ...g, createdAt };
}

export function updateGoal(db: DatabaseSync, id: number, input: Record<string, unknown>): Goal {
  const was = getGoal(db, id);
  if (!was) throw new InputError("id", "no such goal", 404);
  const g = checked(input, was);
  db.prepare("UPDATE goals SET name = ?, kind = ?, value = ? WHERE id = ?").run(g.name, g.kind, g.value, id);
  return { ...was, ...g };
}

export function removeGoal(db: DatabaseSync, id: number): void {
  if (!Number(db.prepare("DELETE FROM goals WHERE id = ?").run(id).changes)) throw new InputError("id", "no such goal", 404);
}

/** A page pattern as GLOB: * stays, and the characters GLOB treats as special are taken as themselves. */
const glob = (pattern: string) => pattern.replace(/[?[]/g, (c) => `[${c}]`);

/** SQL matching the goal's events, aliased as given. */
export function goalMatch(goal: Goal, alias: string): { sql: string; args: SQLInputValue[] } {
  return goal.kind === "page" ? { sql: `${alias}.name = 'pageview' AND ${alias}.path GLOB ?`, args: [glob(goal.value)] } : { sql: `${alias}.name = ?`, args: [goal.value] };
}

export function goalStats(db: DatabaseSync, siteId: number, o: { range: Range; filters?: Filters; now?: number }): GoalStats[] {
  const { from, to } = windowOf(o.range, o.now ?? Date.now());
  // Events of the visits the filters leave (a page filter: visits that saw it).
  const v = visitFilters(o.filters ?? {});
  const base = ["e.site_id = ?", "e.at >= ?", "e.at < ?", ...v.parts].join(" AND ");
  const baseArgs: SQLInputValue[] = [siteId, from, to, ...v.args];
  const joined = "FROM events e JOIN sessions s ON s.id = e.session";
  const all = (db.prepare(`SELECT count(DISTINCT e.visitor) n ${joined} WHERE ${base} AND e.name = 'pageview'`).get(...baseArgs) as { n: number }).n;
  const currency = mainCurrency(db, siteId);
  return listGoals(db, siteId).map((goal) => {
    const m = goalMatch(goal, "e");
    const where = `${base} AND ${m.sql}`;
    const args = [...baseArgs, ...m.args];
    const r = db.prepare(`SELECT count(DISTINCT e.visitor) visitors, count(DISTINCT e.session) visits ${joined} WHERE ${where}`).get(...args) as { visitors: number; visits: number };
    const revenue = currency
      ? (db.prepare(`SELECT coalesce(sum(amount), 0) n FROM payments WHERE site_id = ? AND currency = ? AND at >= ? AND at < ? AND visit IN (SELECT e.session ${joined} WHERE ${where})`).get(siteId, currency, from, to, ...args) as { n: number }).n
      : 0;
    return { ...goal, visitors: r.visitors, visits: r.visits, rate: all ? r.visitors / all : 0, revenue };
  });
}
