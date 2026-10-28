import { rmSync } from "node:fs";
import { Audit } from "./audit.ts";
import { AGENT_VERSION, DEFAULT_PATHS } from "./config.ts";
import { createDispatcher } from "./dispatch.ts";
import { realExec } from "./exec.ts";
import { lookupGid } from "./fsutil.ts";
import { listen } from "./server.ts";

async function main(): Promise<void> {
  if (process.getuid?.() !== 0) {
    console.error("layer-agent must run as root");
    process.exit(1);
  }
  const paths = DEFAULT_PATHS;
  const ctx = { paths, exec: realExec };

  let gid: number | null = null;
  if (paths.socketGroup) {
    gid = await lookupGid(realExec, paths.socketGroup);
    if (gid === null) {
      console.error(`group ${paths.socketGroup} doesn't exist (run the installer first)`);
      process.exit(1);
    }
  }

  const server = await listen(paths.socket, createDispatcher(ctx, new Audit(paths.auditLog)), { gid });
  console.log(`layer-agent ${AGENT_VERSION} listening on ${paths.socket}`);

  const shutdown = () => {
    server.close();
    rmSync(paths.socket, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("layer-agent failed to start:", err);
  process.exit(1);
});
