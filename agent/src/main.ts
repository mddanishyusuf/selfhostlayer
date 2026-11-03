import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Audit } from "./audit.ts";
import { AGENT_VERSION, DEFAULT_PATHS } from "./config.ts";
import { createDispatcher } from "./dispatch.ts";
import { realExec } from "./exec.ts";
import { filesOnDisk, ownsPath } from "./actions/repair.ts";
import { adoptManaged, lookupGid, manageFiles } from "./fsutil.ts";
import { realSpawn } from "./sandbox.ts";
import { listen } from "./server.ts";

async function main(): Promise<void> {
  if (process.getuid?.() !== 0) {
    console.error("layer-agent must run as root");
    process.exit(1);
  }
  const paths = DEFAULT_PATHS;
  const ctx = { paths, exec: realExec, spawn: realSpawn };

  let gid: number | null = null;
  if (paths.socketGroup) {
    gid = await lookupGid(realExec, paths.socketGroup);
    if (gid === null) {
      console.error(`group ${paths.socketGroup} doesn't exist (run the installer first)`);
      process.exit(1);
    }
  }

  // The agent's own state (managed files, PHP's and MySQL 8's state, archives)
  // lives here; a fresh agent-only server has nothing in /var/lib yet.
  mkdirSync(dirname(paths.managedDir), { recursive: true, mode: 0o700 });

  // Generated files are recorded as they're written, for `layer repair`; ones
  // from before this version are recorded as they are now.
  manageFiles({ dir: paths.managedDir, owns: ownsPath(paths) });
  const adopted = adoptManaged(filesOnDisk(paths));
  if (adopted) console.log(`recorded ${adopted} existing generated file(s) for layer repair`);

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
