export * from "./validate.ts";

/**
 * The complete allowlist of agent actions. The agent rejects any action name
 * that isn't listed here, and each one has a typed handler in agent/src/actions.
 */
export const ACTIONS = [
  "system.info",
  "node.install",
  "app.create",
  "app.delete",
  "env.write",
  "unit.write",
  "unit.start",
  "unit.stop",
  "unit.status",
  "release.point",
  "proxy.set",
  "logs.tail",
  "security.score",
] as const;

export type ActionName = (typeof ACTIONS)[number];

export interface Request {
  id: string;
  action: ActionName;
  params: Record<string, unknown>;
}

export type Response =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } }
  | { id: string; chunk: string };

export function isActionName(value: unknown): value is ActionName {
  return ACTIONS.includes(value as ActionName);
}
