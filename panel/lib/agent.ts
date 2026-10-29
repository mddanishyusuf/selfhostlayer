import { callAgent, type ActionName, type CallOptions } from "@layer/protocol";
import { config } from "./config";

export interface SystemInfo {
  agentVersion: string;
  hostname: string;
  os: { id: string; version: string; name: string };
  kernel: string;
  arch: string;
  cpus: number;
  loadavg: number[];
  memoryMb: { total: number; available: number };
  swapMb: { total: number; free: number };
  diskGb: { total: number; free: number };
  uptimeSec: number;
  nodeVersions: string[];
  caddy: string;
}

export interface AppSummary {
  slug: string;
  ports: { blue: number | null; green: number | null };
  live: "blue" | "green" | "static" | null;
  domains: string[];
  unitFile: boolean;
}

/** How `systemctl show` prints a time. */
const systemdTime = (ms: number) => `Thu ${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;

const FAKE: Partial<Record<ActionName, unknown>> = {
  "system.info": {
    agentVersion: "dev",
    hostname: "cx23-fsn1",
    os: { id: "ubuntu", version: "24.04", name: "Ubuntu 24.04.5 LTS" },
    kernel: "6.8.0-147-generic",
    arch: "x64",
    cpus: 2,
    loadavg: [0.42, 0.31, 0.27],
    memoryMb: { total: 3820, available: 2240 },
    swapMb: { total: 2048, free: 2001 },
    diskGb: { total: 38.2, free: 24.6 },
    uptimeSec: 1_314_000,
    nodeVersions: ["22.23.4", "24.13.1"],
    caddy: "active",
  } satisfies SystemInfo,
  "app.list": {
    apps: [
      { slug: "piqo", ports: { blue: 4000, green: 4001 }, live: "green", domains: ["piqo.app", "www.piqo.app"], unitFile: true },
      { slug: "maillayer", ports: { blue: 4002, green: 4003 }, live: "blue", domains: ["maillayer.com"], unitFile: true },
      { slug: "picker", ports: { blue: 4004, green: 4005 }, live: null, domains: [], unitFile: false },
    ] satisfies AppSummary[],
  },
  // Sample answers for the dev previews (the same for every app).
  "firewall.status": {
    ufw: {
      installed: true,
      enabled: true,
      rules: [
        ["tcp", "22", "ssh"],
        ["tcp", "80", "http"],
        ["tcp", "443", "https"],
        ["udp", "443", "http3"],
      ].flatMap(([protocol, port, comment]) => [false, true].map((ipv6) => ({ action: "allow", protocol, port, from: "Anywhere", ipv6, comment }))),
    },
    fail2ban: { running: true, jails: [{ name: "sshd", currentlyFailed: 2, totalFailed: 31, currentlyBanned: 2, totalBanned: 9, banned: ["185.220.101.47", "45.148.10.243"] }] },
  },
  "service.status": {
    slug: "piqo",
    installed: { redis: true, postgres: true },
    redis: { port: 6400, memoryMb: 64, url: "redis://default:51b0e9c2aa7741f8@127.0.0.1:6400", active: true, memoryUsedMb: 23, answering: true },
    postgres: { database: "app_piqo", url: "postgresql://app_piqo:9f2c41d07be6a1e3@127.0.0.1:5432/app_piqo", sizeMb: 48.2, answering: true },
  },
  "unit.status": {
    slug: "piqo",
    live: "blue",
    unitFile: true,
    blue: { state: "active", subState: "running", enabled: true, pid: 4120, memoryMb: 212, restarts: 0, since: null, release: "a1c9e42", port: 4000, live: true },
    green: { state: "inactive", subState: "dead", enabled: false, pid: null, memoryMb: null, restarts: 0, since: null, release: null, port: 4001, live: false },
  },
  "security.score": { slug: "piqo", color: "blue", score: 1.3, rating: "OK" },
  "cron.list": {
    slug: "piqo",
    jobs: [
      {
        name: "aggregate-stats",
        calendar: "*-*-* *:00:00",
        nextRun: systemdTime(Date.now() + 42 * 60_000),
        lastRun: systemdTime(Date.now() - 18 * 60_000),
        running: false,
        lastResult: "success",
        lastExitStatus: 0,
      },
    ],
  },
  "cron.history": {
    slug: "piqo",
    name: "aggregate-stats",
    runs: [
      { invocation: "b2", startedAt: new Date(Date.now() - 18 * 60_000).toISOString(), finishedAt: new Date(Date.now() - 18 * 60_000 + 2400).toISOString(), status: "success", exitStatus: 0, output: ["Aggregating 41,203 events…", "Wrote 1,204 daily rows in 2.3s"] },
      { invocation: "b1", startedAt: new Date(Date.now() - 78 * 60_000).toISOString(), finishedAt: new Date(Date.now() - 78 * 60_000 + 900).toISOString(), status: "failed", exitStatus: 1, output: ["Error: SQLITE_BUSY: database is locked"] },
    ],
  },
};

export async function agent<T>(action: ActionName, params: Record<string, unknown> = {}, opts: Omit<CallOptions, "socket"> = {}): Promise<T> {
  if (config.fakeAgent && action in FAKE) return FAKE[action] as T;
  return callAgent<T>(action, params, { ...opts, socket: config.agentSocket });
}
