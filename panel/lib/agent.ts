import { callAgent, type ActionName } from "@layer/protocol";
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
  live: "blue" | "green" | null;
  domains: string[];
  unitFile: boolean;
}

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
};

export async function agent<T>(action: ActionName, params: Record<string, unknown> = {}): Promise<T> {
  if (config.fakeAgent && action in FAKE) return FAKE[action] as T;
  return callAgent<T>(action, params, { socket: config.agentSocket });
}
