import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PATHS, type Paths } from "../src/config.ts";
import type { Context } from "../src/context.ts";
import { BIN, type Exec, type ExecResult } from "../src/exec.ts";
import type { Spawn } from "../src/sandbox.ts";

export interface FakeSpawn {
  spawn: Spawn;
  calls: string[][];
  /** Exit code and output for a call; default 0 and no output. */
  respond?: (
    file: string,
    args: string[],
  ) => { code: number; output?: string } | undefined | Promise<{ code: number; output?: string } | undefined>;
}

export function fakeSpawn(): FakeSpawn {
  const fake: FakeSpawn = { spawn: undefined as unknown as Spawn, calls: [] };
  fake.spawn = async (file, args, opts) => {
    fake.calls.push([file, ...args]);
    const r = (await fake.respond?.(file, args)) ?? { code: 0 };
    if (r.output) opts.onData(r.output);
    opts.stdin?.resume();
    return { code: r.code };
  };
  return fake;
}

export interface FakeExec {
  exec: Exec;
  calls: string[][];
  users: Map<string, { uid: number; gid: number }>;
  /** Return a result to override the default for a command (e.g. make a reload fail). */
  respond?: (file: string, args: string[]) => ExecResult | undefined;
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

  const fake: FakeExec = { exec: undefined as unknown as Exec, calls, users };
  fake.exec = async (file, args, opts = {}) => {
    calls.push([file, ...args]);
    let result: ExecResult = ok();
    const override = fake.respond?.(file, args);
    if (override) {
      result = override;
    } else if (file === BIN.getent && args[0] === "passwd") {
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
  return fake;
}

export interface TestEnv {
  root: string;
  paths: Paths;
  ctx: Context;
  fake: FakeExec;
  spawner: FakeSpawn;
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
    toolsRoot: join(root, "opt", "layer", "tools"),
    systemdDir: join(root, "etc", "systemd", "system"),
    caddySitesDir: join(root, "etc", "caddy", "sites"),
    staticRoot: join(root, "srv", "static"),
    staticGroup: null,
    archiveRoot: join(root, "var", "lib", "layer-agent", "archive"),
    // High range, so the real isPortFree check doesn't collide with dev servers.
    portRange: { min: 46000, max: 46099 },
    // Tests must not depend on how full the developer's disk is.
    minFreeDisk: 0,
  };
  const fake = fakeExec();
  const spawner = fakeSpawn();
  return {
    root,
    paths,
    ctx: { paths, exec: fake.exec, spawn: spawner.spawn },
    fake,
    spawner,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
