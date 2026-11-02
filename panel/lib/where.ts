// The database viewer's visual query builder: its filters, the operators it
// offers, and how they travel in the URL (w=). No imports, so both the server
// page and the builder in the browser use it. The agent turns filters into
// SQL with quoted names and values (agent/src/sql-where.ts).

export type FilterOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains" | "starts" | "ends" | "null" | "not_null" | "in";
export interface Filter {
  column: string;
  op: FilterOp;
  /** Text; a list for "in"; nothing for "null" and "not_null". */
  value?: string | string[];
}
export interface Where {
  match: "all" | "any";
  filters: Filter[];
}

/** The operators the builder offers, in its menu's order. */
export const FILTER_OPS: { op: FilterOp; label: string; takes: "value" | "list" | "none" }[] = [
  { op: "eq", label: "is", takes: "value" },
  { op: "ne", label: "is not", takes: "value" },
  { op: "contains", label: "contains", takes: "value" },
  { op: "not_contains", label: "doesn't contain", takes: "value" },
  { op: "starts", label: "starts with", takes: "value" },
  { op: "ends", label: "ends with", takes: "value" },
  { op: "gt", label: ">", takes: "value" },
  { op: "gte", label: "≥", takes: "value" },
  { op: "lt", label: "<", takes: "value" },
  { op: "lte", label: "≤", takes: "value" },
  { op: "in", label: "is one of", takes: "list" },
  { op: "null", label: "is NULL", takes: "none" },
  { op: "not_null", label: "is not NULL", takes: "none" },
];

/** The w= search parameter: the builder's filters as JSON. Anything malformed is ignored, not an error. */
export function parseWhere(value: string | undefined): Where | undefined {
  if (!value) return undefined;
  try {
    const raw = JSON.parse(value) as { match?: unknown; filters?: unknown };
    if (!Array.isArray(raw.filters)) return undefined;
    const filters = raw.filters.flatMap((f): Filter[] => {
      const { column, op, value: v } = (f ?? {}) as Record<string, unknown>;
      const def = FILTER_OPS.find((o) => o.op === op);
      if (typeof column !== "string" || !column || !def) return [];
      if (def.takes === "none") return [{ column, op: def.op }];
      if (def.takes === "list") return Array.isArray(v) && v.length && v.every((x) => typeof x === "string") ? [{ column, op: def.op, value: v as string[] }] : [];
      return typeof v === "string" ? [{ column, op: def.op, value: v }] : [];
    });
    return filters.length ? { match: raw.match === "any" ? "any" : "all", filters: filters.slice(0, 20) } : undefined;
  } catch {
    return undefined;
  }
}

export const encodeWhere = (where: Where | undefined) => (where?.filters.length ? JSON.stringify(where) : undefined);
