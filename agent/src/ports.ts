import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { COLORS } from "@layer/protocol";
import { ActionError } from "./errors.ts";
import { parseColorEnvPort } from "./templates/env-file.ts";

/**
 * Ports in use by apps, read from /etc/layer/apps/<slug>/{blue,green}.env.
 * Those files are the only record of allocation: nothing hidden in a DB.
 */
export function allocatedPorts(appEtcRoot: string): Set<number> {
  const ports = new Set<number>();
  if (!existsSync(appEtcRoot)) return ports;
  for (const slug of readdirSync(appEtcRoot)) {
    for (const color of COLORS) {
      const file = join(appEtcRoot, slug, `${color}.env`);
      if (!existsSync(file)) continue;
      const port = parseColorEnvPort(readFileSync(file, "utf8"));
      if (port !== null) ports.add(port);
    }
  }
  return ports;
}

/** True if nothing on the box is listening on 127.0.0.1:<port>. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** Picks the two lowest ports in range that no app owns and nothing listens on. */
export async function allocatePortPair(
  appEtcRoot: string,
  range: { min: number; max: number },
  isFree: (port: number) => Promise<boolean> = isPortFree,
): Promise<[number, number]> {
  const taken = allocatedPorts(appEtcRoot);
  const picked: number[] = [];
  for (let port = range.min; port <= range.max && picked.length < 2; port++) {
    if (!taken.has(port) && (await isFree(port))) picked.push(port);
  }
  if (picked.length < 2) {
    throw new ActionError("no_ports", `no free ports left in ${range.min}-${range.max}`);
  }
  return [picked[0]!, picked[1]!];
}
