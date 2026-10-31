export * from "./validate.ts";
export * from "./manifest.ts";
export * from "./client.ts";

/**
 * The complete allowlist of agent actions. The agent rejects any action name
 * that isn't listed here, and each one has a typed handler in agent/src/actions.
 */
export const ACTIONS = [
  "system.info",
  "system.repair",
  "node.install",
  "tool.install",
  "app.list",
  "app.create",
  "app.delete",
  "env.write",
  "unit.write",
  "unit.start",
  "unit.stop",
  "unit.status",
  "release.point",
  "release.prune",
  "source.fetch",
  "build.run",
  "build.cancel",
  "cache.clean",
  "cron.write",
  "cron.delete",
  "cron.run",
  "cron.list",
  "cron.history",
  "backup.snapshot",
  "backup.restore",
  "backup.discard",
  "data.import",
  "service.install",
  "service.status",
  "redis.add",
  "redis.remove",
  "postgres.add",
  "postgres.remove",
  "mysql.add",
  "mysql.remove",
  "mongodb.add",
  "mongodb.remove",
  "db.browse",
  "firewall.status",
  "panel.site",
  "panel.address",
  "panel.access",
  "apps.domain",
  "proxy.set",
  "static.publish",
  "logs.tail",
  "requests.tail",
  "audit.tail",
  "metrics.sample",
  "metrics.disk",
  "security.score",
  "update.check",
  "update.start",
  "update.status",
  "catalog.list",
  "catalog.fetch",
] as const;

export type ActionName = (typeof ACTIONS)[number];

export interface Request {
  id: string;
  action: ActionName;
  params: Record<string, unknown>;
}

/** id is null only when the request was too broken to read one. */
export type Response =
  | { id: string; ok: true; result: unknown }
  | { id: string | null; ok: false; error: { code: string; message: string } }
  | { id: string; chunk: string };

export function isActionName(value: unknown): value is ActionName {
  return ACTIONS.includes(value as ActionName);
}
