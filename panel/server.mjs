// Production entry point. Next.js's generated standalone server.js can only
// listen on a TCP port; the panel listens on a unix socket that only Caddy can
// reach (/run/layer-panel/panel.sock), so apps on 127.0.0.1 can't talk to it
// directly. Uses Next's public custom-server API with the build's own config.
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import module from "node:module";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
process.env.NODE_ENV = "production";
process.chdir(dir);

const socket = process.env.LAYER_PANEL_SOCKET;

// After a server action redirects, Next fetches the target page from its own
// origin, which it assumes is http://localhost:3000. Over the socket that
// would fail, or worse, send the admin's cookies to an app on port 3000. Pin
// the origin to a name that never leaves this process and serve it over the
// socket. Set before Next loads so its fetch patch wraps this one.
if (socket) {
  const origin = "http://layer-panel.invalid";
  process.env.__NEXT_PRIVATE_ORIGIN = origin;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) return realFetch(input, init);
    return new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
      const req = request({ socketPath: socket, path: url.pathname + url.search, method: init?.method ?? "GET", headers }, (res) => {
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const one of [v].flat()) if (one !== undefined) out.append(k, one);
        resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: out }));
      });
      req.on("error", reject);
      req.end();
    });
  };
}

const require = module.createRequire(import.meta.url);
const { config } = JSON.parse(readFileSync(join(dir, ".next", "required-server-files.json"), "utf8"));
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
const next = require("next");

const app = next({ dev: false, dir, conf: config });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => handle(req, res));

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
