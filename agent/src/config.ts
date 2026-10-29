// Every filesystem location the agent touches. Production uses the defaults;
// tests point the roots at temp dirs.

export interface Paths {
  socket: string;
  /** Group allowed to connect to the socket (the panel's user). null skips chown (tests). */
  socketGroup: string | null;
  auditLog: string;
  appsRoot: string;
  appEtcRoot: string;
  nodeRoot: string;
  /** Other runtimes builds may need (bun), read-only like Node. */
  toolsRoot: string;
  systemdDir: string;
  caddySitesDir: string;
  /** Published static sites, served by Caddy's file_server. */
  staticRoot: string;
  /** Group that lets Caddy read published files; null uses the owner's group (tests). */
  staticGroup: string | null;
  /** Where app.delete moves data/ when keepData is set. */
  archiveRoot: string;
  /** Backup snapshots waiting for the panel to upload them (root:<socketGroup> 750). */
  stagingDir: string;
  /** Where the panel puts downloaded backups for backup.restore. */
  restoreDir: string;
  /** Files in restoreDir must belong to this user (the panel's). null skips the check (tests). */
  panelUser: string | null;
  /** Where systemd keeps Persistent= timer stamps (stamp-<unit>.timer). */
  timerStampDir: string;
  /** Node with node:sqlite, for jobs the agent runs as app users. */
  runtimeNode: string;
  /** Supplementary group for every app user. */
  appsGroup: string;
  nodeDistBase: string;
  portRange: { min: number; max: number };
  /** Builds refuse to start below this fraction of free disk on appsRoot. */
  minFreeDisk: number;
}

export const DEFAULT_PATHS: Paths = {
  socket: "/run/layer/agent.sock",
  socketGroup: "layer",
  auditLog: "/var/log/layer/audit.jsonl",
  appsRoot: "/srv/apps",
  appEtcRoot: "/etc/layer/apps",
  nodeRoot: "/opt/layer/node",
  toolsRoot: "/opt/layer/tools",
  systemdDir: "/etc/systemd/system",
  caddySitesDir: "/etc/caddy/sites",
  staticRoot: "/srv/static",
  staticGroup: "caddy",
  archiveRoot: "/var/lib/layer-agent/archive",
  stagingDir: "/var/lib/layer-staging",
  restoreDir: "/var/lib/layer/restore",
  panelUser: "layer",
  runtimeNode: "/opt/layer/runtime/bin/node",
  timerStampDir: "/var/lib/systemd/timers",
  appsGroup: "layer-apps",
  nodeDistBase: "https://nodejs.org/dist",
  portRange: { min: 4000, max: 4999 },
  minFreeDisk: 0.15,
};

// Replaced at bundle time by esbuild --define.
declare const LAYER_AGENT_VERSION: string | undefined;
export const AGENT_VERSION = typeof LAYER_AGENT_VERSION === "string" ? LAYER_AGENT_VERSION : "dev";
