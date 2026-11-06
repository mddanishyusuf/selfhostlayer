export * from "./validate.ts";
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
  "files.place",
  "php.write",
  "php.remove",
  "php.status",
  "mysql8.add",
  "mysql8.remove",
  "mysql8.status",
  "ghost.fetch",
  "ghost.setup",
  "wordpress.fetch",
  "wordpress.install",
  "wordpress.config",
  "wordpress.status",
  "wordpress.run",
  "wordpress.import",
  "build.cancel",
  "cache.clean",
  "cron.write",
  "cron.delete",
  "cron.run",
  "cron.list",
  "cron.history",
  "worker.write",
  "worker.delete",
  "worker.control",
  "worker.list",
  "app.run",
  "app.run-stop",
  "backup.snapshot",
  "backup.restore",
  "backup.discard",
  "backup.fetch",
  "backup.put",
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
  "db.count",
  "db.update",
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
export * from "./version.ts";
