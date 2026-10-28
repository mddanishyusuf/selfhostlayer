// Production entry point. Next.js's generated standalone server.js can only
// listen on a TCP port; the panel listens on a unix socket that only Caddy can
// reach (/run/layer-panel/panel.sock), so apps on 127.0.0.1 can't talk to it
// directly. Uses Next's public custom-server API with the build's own config.
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import module from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
process.env.NODE_ENV = "production";
process.chdir(dir);

const require = module.createRequire(import.meta.url);
const { config } = JSON.parse(readFileSync(join(dir, ".next", "required-server-files.json"), "utf8"));
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
const next = require("next");

const app = next({ dev: false, dir, conf: config });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => handle(req, res));
const socket = process.env.LAYER_PANEL_SOCKET;

if (socket) {
  if (existsSync(socket)) rmSync(socket);
  server.listen(socket, () => {
    // The socket's group is the process's group (layer-web, set by the unit),
    // which Caddy shares; the UMask makes it 0700 until this chmod.
    chmodSync(socket, 0o660);
    console.log(`layer-panel listening on ${socket}`);
  });
} else {
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, "127.0.0.1", () => console.log(`layer-panel listening on 127.0.0.1:${port}`));
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
