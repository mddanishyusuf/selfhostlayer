import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PATHS, type Paths } from "../src/config.ts";
import type { Context } from "../src/context.ts";
import { BIN, type Exec, type ExecResult } from "../src/exec.ts";

export interface FakeExec {
  exec: Exec;
  calls: string[][];
  users: Map<string, { uid: number; gid: number }>;
}

/**
 * Records every command and simulates the few that matter: getent/useradd/
 * userdel keep a fake user table. Created users get the test process's own
 * uid/gid, so chown works without root.
 */
export function fakeExec(): FakeExec {
  const calls: string[][] = [];
  const users = new Map<string, { uid: number; gid: number }>();
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

  const exec: Exec = async (file, args, opts = {}) => {
    calls.push([file, ...args]);
    let result: ExecResult = ok();
    if (file === BIN.getent && args[0] === "passwd") {
      const user = users.get(args[1]!);
      result = user ? ok(`${args[1]}:x:${user.uid}:${user.gid}::/srv/apps:/usr/sbin/nologin\n`) : { code: 2, stdout: "", stderr: "" };
    } else if (file === BIN.useradd) {
      users.set(args.at(-1)!, { uid: process.getuid!(), gid: process.getgid!() });
    } else if (file === BIN.userdel) {
      users.delete(args.at(-1)!);
    }
    if (result.code !== 0 && !opts.allowFail) throw new Error(`fake exec: ${file} failed`);
    return result;
  };
  return { exec, calls, users };
}

export interface TestEnv {
  root: string;
  paths: Paths;
  ctx: Context;
  fake: FakeExec;
  cleanup: () => void;
}

export function testEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "layer-agent-test-"));
  const paths: Paths = {
    ...DEFAULT_PATHS,
    socket: join(root, "run", "agent.sock"),
    socketGroup: null,
    auditLog: join(root, "log", "audit.jsonl"),
    appsRoot: join(root, "srv", "apps"),
    appEtcRoot: join(root, "etc", "layer", "apps"),
    nodeRoot: join(root, "opt", "layer", "node"),
    systemdDir: join(root, "etc", "systemd", "system"),
    caddySitesDir: join(root, "etc", "caddy", "sites"),
    archiveRoot: join(root, "var", "lib", "layer-agent", "archive"),
    // High range, so the real isPortFree check doesn't collide with dev servers.
    portRange: { min: 46000, max: 46099 },
  };
  const fake = fakeExec();
  return { root, paths, ctx: { paths, exec: fake.exec }, fake, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
