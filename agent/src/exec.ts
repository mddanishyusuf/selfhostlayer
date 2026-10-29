import { execFile } from "node:child_process";

// Absolute paths only, so nothing depends on PATH lookups.
export const BIN = {
  useradd: "/usr/sbin/useradd",
  userdel: "/usr/sbin/userdel",
  getent: "/usr/bin/getent",
  systemctl: "/usr/bin/systemctl",
  pkill: "/usr/bin/pkill",
  tar: "/usr/bin/tar",
  chmod: "/usr/bin/chmod",
  unzip: "/usr/bin/unzip",
  journalctl: "/usr/bin/journalctl",
  du: "/usr/bin/du",
  systemdAnalyze: "/usr/bin/systemd-analyze",
  aptGet: "/usr/bin/apt-get",
  runuser: "/usr/sbin/runuser",
  psql: "/usr/bin/psql",
  pgDump: "/usr/bin/pg_dump",
  fail2banClient: "/usr/bin/fail2ban-client",
} as const;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Return non-zero exits instead of throwing. */
  allowFail?: boolean;
}

/** Runs one program with an argv array. Never through a shell. */
export type Exec = (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export class ExecError extends Error {
  result: ExecResult;

  constructor(file: string, args: string[], result: ExecResult) {
    super(`${file} ${args.join(" ")} exited ${result.code}: ${result.stderr.trim().slice(0, 500)}`);
    this.name = "ExecError";
    this.result = result;
  }
}

export const SAFE_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };

export const realExec: Exec = (file, args, opts = {}) => {
  if (!file.startsWith("/")) {
    return Promise.reject(new Error(`exec needs an absolute path, got ${file}`));
  }
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { shell: false, env: SAFE_ENV, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        const result = { code, stdout: String(stdout), stderr: String(stderr) };
        if (err && !opts.allowFail) {
          reject(new ExecError(file, args, result));
        } else {
          resolve(result);
        }
      },
    );
  });
};
