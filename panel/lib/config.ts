// Where the panel finds its state. Production values come from the systemd
// unit; anything unset falls back to ~/.selfhostlayer-dev for `next dev`.
// That folder must stay outside the project: `next dev` watches the project,
// and SQLite writing its WAL there makes every page reload itself forever.
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const isProd = process.env.NODE_ENV === "production";
const devDir = process.env.LAYER_DEV_DIR ?? join(homedir(), ".selfhostlayer-dev");

export const config = {
  isProd,
  dbPath: process.env.LAYER_DB ?? join(devDir, "panel.db"),
  /** The panel's writable folder (/var/lib/layer): the DB, and backups being restored in restore/. */
  get dataDir() {
    return dirname(this.dbPath);
  },
  secretKeyFile: process.env.LAYER_SECRET_KEY_FILE ?? join(devDir, "secret.key"),
  setupTokenFile: process.env.LAYER_SETUP_TOKEN_FILE ?? join(devDir, "setup-token"),
  agentSocket: process.env.LAYER_AGENT_SOCKET ?? "/run/layer/agent.sock",
  /** Development only: serve sample data instead of calling the agent. */
  fakeAgent: !isProd && process.env.LAYER_FAKE_AGENT === "1",
};
