// Incidents: raise() opens one (and notifies every enabled channel once),
// resolve() closes it (one recovery message). An open incident is never
// repeated, however often the same problem is seen again.
import { decrypt, encrypt } from "../crypto";
import { db, now } from "../db";
import { send, type AlertMessage, type ChannelConfig } from "./notify";

export interface Channel {
  id: number;
  kind: ChannelConfig["kind"];
  name: string;
  config: ChannelConfig;
  enabled: boolean;
}

export interface Incident {
  id: number;
  key: string;
  title: string;
  detail: string;
  link: string | null;
  projectId: number | null;
  openedAt: number;
  resolvedAt: number | null;
  notifyErrors: string | null;
}

interface ChannelRow {
  id: number;
  kind: Channel["kind"];
  name: string;
  config_enc: string;
  enabled: number;
}

interface IncidentRow {
  id: number;
  key: string;
  title: string;
  detail: string;
  link: string | null;
  project_id: number | null;
  opened_at: number;
  resolved_at: number | null;
  notify_errors: string | null;
}

const toIncident = (r: IncidentRow): Incident => ({
  id: r.id,
  key: r.key,
  title: r.title,
  detail: r.detail,
  link: r.link,
  projectId: r.project_id,
  openedAt: r.opened_at,
  resolvedAt: r.resolved_at,
  notifyErrors: r.notify_errors,
});

export function listChannels(): Channel[] {
  return (db().prepare("SELECT * FROM alert_channels ORDER BY created_at").all() as unknown as ChannelRow[]).map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    config: JSON.parse(decrypt(r.config_enc)) as ChannelConfig,
    enabled: r.enabled === 1,
  }));
}

export function addChannel(name: string, config: ChannelConfig): number {
  return Number(db().prepare("INSERT INTO alert_channels (kind, name, config_enc, created_at) VALUES (?, ?, ?, ?)").run(config.kind, name, encrypt(JSON.stringify(config)), now()).lastInsertRowid);
}

export function removeChannel(id: number): void {
  db().prepare("DELETE FROM alert_channels WHERE id = ?").run(id);
}

export function openIncident(key: string): Incident | null {
  const row = db().prepare("SELECT * FROM alert_incidents WHERE key = ? AND resolved_at IS NULL").get(key) as IncidentRow | undefined;
  return row ? toIncident(row) : null;
}

export function listIncidents(limit = 50): Incident[] {
  return (db().prepare("SELECT * FROM alert_incidents ORDER BY resolved_at IS NOT NULL, opened_at DESC LIMIT ?").all(limit) as unknown as IncidentRow[]).map(toIncident);
}

type Sender = (channel: Channel, message: AlertMessage) => Promise<void>;

// On globalThis: Next.js may load this module more than once (the monitor and
// server actions), and every copy must use the same server name and sender.
const g = globalThis as unknown as { layerAlerts?: { server: string; sender: Sender | null } };
const settings = (g.layerAlerts ??= { server: "Self Host Layer", sender: null });
const sender: Sender = (channel, message) => (settings.sender ?? ((c, m) => send(c.config, m, settings.server)))(channel, message);

/** Server name in messages, and (for tests) a replacement sender. */
export function configureAlerts(opts: { serverName?: string; sender?: Sender }): void {
  if (opts.serverName) settings.server = opts.serverName;
  if (opts.sender) settings.sender = opts.sender;
}

/** Sends to every enabled channel; returns the failures (never throws). */
export async function notifyAll(message: AlertMessage, channels = listChannels().filter((c) => c.enabled)): Promise<string[]> {
  const errors: string[] = [];
  await Promise.all(
    channels.map(async (c) => {
      try {
        await sender(c, message);
      } catch (err) {
        errors.push(`${c.name}: ${(err as Error).message}`);
      }
    }),
  );
  return errors;
}

export interface RaiseInput {
  title: string;
  detail?: string;
  link?: string | null;
  projectId?: number | null;
}

/** Opens an incident for key and notifies once. Returns false if one is already open. */
export async function raise(key: string, input: RaiseInput): Promise<boolean> {
  if (openIncident(key)) return false;
  const result = db()
    .prepare("INSERT OR IGNORE INTO alert_incidents (key, title, detail, link, project_id, opened_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(key, input.title, input.detail ?? "", input.link ?? null, input.projectId ?? null, now());
  if (result.changes === 0) return false;
  const errors = await notifyAll({ event: "opened", key, title: input.title, detail: input.detail ?? "", link: input.link ?? null, at: new Date().toISOString() });
  if (errors.length) db().prepare("UPDATE alert_incidents SET notify_errors = ? WHERE id = ?").run(errors.join("\n"), Number(result.lastInsertRowid));
  return true;
}

/** Closes the open incident for key (if any) and sends one recovery message. */
export async function resolve(key: string, detail = ""): Promise<boolean> {
  const incident = openIncident(key);
  if (!incident) return false;
  db().prepare("UPDATE alert_incidents SET resolved_at = ? WHERE id = ?").run(now(), incident.id);
  await notifyAll({ event: "resolved", key, title: incident.title, detail, link: incident.link, at: new Date().toISOString() });
  return true;
}
