// Where the panel finds its state. Production values come from the systemd
// unit; anything unset falls back to a local ./.dev folder for `next dev`.
import { join } from "node:path";

const isProd = process.env.NODE_ENV === "production";
const devDir = join(process.cwd(), ".dev");

export const config = {
  isProd,
  dbPath: process.env.LAYER_DB ?? join(devDir, "panel.db"),
  secretKeyFile: process.env.LAYER_SECRET_KEY_FILE ?? join(devDir, "secret.key"),
  setupTokenFile: process.env.LAYER_SETUP_TOKEN_FILE ?? join(devDir, "setup-token"),
  agentSocket: process.env.LAYER_AGENT_SOCKET ?? "/run/layer/agent.sock",
  /** Development only: serve sample data instead of calling the agent. */
  fakeAgent: !isProd && process.env.LAYER_FAKE_AGENT === "1",
};
