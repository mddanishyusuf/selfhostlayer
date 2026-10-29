import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { SAFE_ENV } from "./exec.ts";

export const SYSTEMD_RUN = "/usr/bin/systemd-run";

export interface SandboxOptions {
  /** Transient unit name, e.g. layer-build-piqo. */
  unit: string;
  /** Runs as this user and its group (app-<slug>). Never root. */
  user: string;
  cwd: string;
  /** The only paths it may write (everything else is read-only or hidden). */
  readWrite: string[];
  env: Record<string, string>;
  /** Optional env files, loaded by systemd as root (the app user can't read them). */
  envFiles?: string[];
  memoryMb: number;
  timeoutSec: number;
  /** Builds need the npm registry; unpacking and cleanup don't; "localhost" reaches only this box (the app's Postgres). */
  network: boolean | "localhost";
  command: string[];
}

/**
 * systemd-run arguments for a one-off sandboxed job as an app user: the same
 * lockdown as app units, at low CPU/IO priority so live apps stay responsive.
 * RestrictSUIDSGID is left out on purpose: under it systemd blocks openat2(),
 * which GNU tar on Ubuntu 26.04 needs (found on a real 26.04 box).
 */
export function sandboxArgs(o: SandboxOptions): string[] {
  const props: string[] = [
    "NoNewPrivileges=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "ProtectSystem=strict",
    `ReadWritePaths=${o.readWrite.join(" ")}`,
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes",
    "ProtectClock=yes",
    "ProtectHostname=yes",
    "ProtectProc=invisible",
    "RestrictNamespaces=yes",
    "RestrictRealtime=yes",
    "LockPersonality=yes",
    "SystemCallFilter=@system-service",
    "SystemCallErrorNumber=EPERM",
    "SystemCallArchitectures=native",
    "UMask=0027",
    `MemoryMax=${o.memoryMb}M`,
    "MemorySwapMax=2G",
    "TasksMax=2048",
    "CPUWeight=20",
    "Nice=10",
    "IOSchedulingClass=best-effort",
    "IOSchedulingPriority=7",
    `RuntimeMaxSec=${o.timeoutSec}`,
    ...(o.network === true
      ? ["RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK"]
      : o.network === "localhost"
        ? ["RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "IPAddressDeny=any", "IPAddressAllow=localhost"]
        : ["RestrictAddressFamilies=AF_UNIX", "IPAddressDeny=any"]),
    // "-": a missing file is fine.
    ...(o.envFiles ?? []).map((f) => `EnvironmentFile=-${f}`),
  ];
  return [
    "--quiet",
    "--wait",
    "--collect",
    // Connects the job's stdin/stdout/stderr to ours: output streams back live.
    "--pipe",
    "--service-type=exec",
    `--unit=${o.unit}`,
    `--uid=${o.user}`,
    `--gid=${o.user}`,
    `--working-directory=${o.cwd}`,
    ...props.map((p) => `--property=${p}`),
    ...Object.entries(o.env).map(([k, v]) => `--setenv=${k}=${v}`),
    "--",
    ...o.command,
  ];
}

export interface SpawnResult {
  code: number;
}

export interface SpawnOptions {
  onData: (chunk: string) => void;
  stdin?: Readable;
  /** A file descriptor for the job's stdout (binary output, e.g. an archive); onData then only gets stderr. */
  stdout?: number;
}

/** Runs a program (argv, no shell), streaming stdout and stderr together. */
export type Spawn = (file: string, args: string[], opts: SpawnOptions) => Promise<SpawnResult>;

export const realSpawn: Spawn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: SAFE_ENV, stdio: [opts.stdin ? "pipe" : "ignore", opts.stdout ?? "pipe", "pipe"] });
    child.stdout?.setEncoding("utf8").on("data", opts.onData);
    child.stderr!.setEncoding("utf8").on("data", opts.onData);
    if (opts.stdin) {
      // The job may exit before reading everything (e.g. a bad archive); that
      // shows up as its exit code, so a broken pipe here isn't an error.
      pipeline(opts.stdin, child.stdin!).catch(() => {});
    }
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1) }));
  });
