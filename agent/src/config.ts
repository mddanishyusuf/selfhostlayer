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
  systemdDir: string;
  caddySitesDir: string;
  /** Where app.delete moves data/ when keepData is set. */
  archiveRoot: string;
  /** Supplementary group for every app user. */
  appsGroup: string;
  nodeDistBase: string;
  portRange: { min: number; max: number };
}

export const DEFAULT_PATHS: Paths = {
  socket: "/run/layer/agent.sock",
  socketGroup: "layer",
  auditLog: "/var/log/layer/audit.jsonl",
  appsRoot: "/srv/apps",
  appEtcRoot: "/etc/layer/apps",
  nodeRoot: "/opt/layer/node",
  systemdDir: "/etc/systemd/system",
  caddySitesDir: "/etc/caddy/sites",
  archiveRoot: "/var/lib/layer-agent/archive",
  appsGroup: "layer-apps",
  nodeDistBase: "https://nodejs.org/dist",
  portRange: { min: 4000, max: 4999 },
};

// Replaced at bundle time by esbuild --define.
declare const LAYER_AGENT_VERSION: string | undefined;
export const AGENT_VERSION = typeof LAYER_AGENT_VERSION === "string" ? LAYER_AGENT_VERSION : "dev";
