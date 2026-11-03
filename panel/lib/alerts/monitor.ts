// Watches the server and raises/resolves incidents. Runs inside the panel,
// started once at server start (instrumentation.ts): every minute for disk,
// crash loops and cron results; every 10 minutes for certificates; every 6
// hours for a newer release (30 minutes after a failed check).
import { sampleMetrics } from "../metrics";
import { agent, type SystemInfo } from "../agent";
import { boxConfig } from "../box";
import { checkCertificate } from "../cert";
import { listCrons, liveCrons } from "../crons";
import { db, now } from "../db";
import { recheckPendingDomains } from "../domain-check";
import { resumeDeployments } from "../deploy";
import { listDomains } from "../domains";
import { backupProjects, markInterrupted, overdueSlugs, scheduledTick } from "../backup/runner";
import { listProjects } from "../projects";
import { listServers, recordCheck, type ServerInfo } from "../servers";
import { checkForUpdates, updateCheckDue } from "../updates";
import { configureAlerts, openIncident, raise, resolve } from "./engine";
import { certVerdict, crashVerdict, cronVerdict, diskVerdict, type UnitSnapshot, type Verdict } from "./rules";

const TICK_MS = 60_000;
const CERT_EVERY_MS = 10 * 60_000;

interface MonitorState {
  started: boolean;
  units: Map<string, UnitSnapshot>;
  lastCertCheck: number;
  lastUpdateCheck: number;
  running: boolean;
}
const g = globalThis as unknown as { layerMonitor?: MonitorState };
const state: MonitorState = (g.layerMonitor ??= { started: false, units: new Map(), lastCertCheck: 0, lastUpdateCheck: 0, running: false });

const panelUrl = (path: string) => `https://${boxConfig().panelHost}${path}`;

async function apply(verdict: Verdict, key: string, open: () => Parameters<typeof raise>[1], recoverNote = ""): Promise<void> {
  if (verdict === "alert") await raise(key, open());
  else if (verdict === "recover") await resolve(key, recoverNote);
}

async function checkDisk(): Promise<void> {
  const info = await agent<SystemInfo>("system.info");
  const used = (info.diskGb.total - info.diskGb.free) / info.diskGb.total;
  await apply(diskVerdict(used, !!openIncident("disk")), "disk", () => ({
    title: `Disk ${Math.round(used * 100)}% full on ${info.hostname}`,
    detail: `${info.diskGb.free} GB free of ${info.diskGb.total} GB. Package caches are emptied automatically before a build when under 25% is free, and builds stop below 15%. Old builds and app data use the rest.`,
    link: panelUrl("/"),
  }), `Disk back to ${Math.round(used * 100)}%.`);
}

/** Missed checks in a row, per server, before it counts as down (about 3 minutes). */
const DOWN_AFTER = 3;
const missed = new Map<number, number>();

/**
 * Every other server (Servers): asked about itself each minute. Its answer is
 * kept for the Servers page; three misses in a row raise an alert (its apps
 * keep running: they don't need the panel). Its disk is watched like this one's.
 */
async function checkServers(): Promise<void> {
  for (const s of listServers()) {
    if (!s.seenAt) continue; // not installed yet
    const key = `server:${s.id}`;
    let info: ServerInfo;
    try {
      info = await agent<ServerInfo>("system.info", {}, { server: s.id });
    } catch (err) {
      const message = (err as Error).message;
      recordCheck(s.id, { error: message });
      const n = (missed.get(s.id) ?? 0) + 1;
      missed.set(s.id, n);
      if (n >= DOWN_AFTER && !openIncident(key)) {
        await raise(key, { title: `${s.name} doesn't answer`, detail: `The panel couldn't reach its agent for ${n} minutes: ${message}. Its apps keep running on their own; deploys to it fail until it answers.`, link: panelUrl("/servers") });
      }
      continue;
    }
    missed.set(s.id, 0);
    recordCheck(s.id, { info });
    if (openIncident(key)) await resolve(key, `${s.name} answers again.`);
    const used = (info.diskGb.total - info.diskGb.free) / info.diskGb.total;
    const disk = `disk:${s.id}`;
    await apply(diskVerdict(used, !!openIncident(disk)), disk, () => ({
      title: `Disk ${Math.round(used * 100)}% full on ${s.name}`,
      detail: `${info.diskGb.free} GB free of ${info.diskGb.total} GB.`,
      link: panelUrl("/servers"),
    }), `Disk on ${s.name} back to ${Math.round(used * 100)}%.`);
  }
}

async function checkApps(): Promise<void> {
  for (const p of listProjects()) {
    if (p.runtime.kind !== "node") continue;
    const status = await agent<{ live: "blue" | "green" | null } & Record<string, { state: string; restarts: number }>>("unit.status", { slug: p.slug }).catch(() => null);
    if (!status?.live) continue;
    const unit = status[status.live]!;
    const snap = { state: unit.state, restarts: unit.restarts };
    const key = `crash:${p.slug}`;
    const prev = state.units.get(key) ?? null;
    state.units.set(key, snap);
    await apply(crashVerdict(prev, snap, !!openIncident(key)), key, () => ({
      title: `${p.slug} is crash-looping`,
      detail: snap.state === "failed" ? "systemd stopped restarting it after repeated crashes. Check its logs: layer logs " + p.slug : `It restarted ${snap.restarts - (prev?.restarts ?? 0)} times in the last minute.`,
      link: panelUrl(`/projects/${p.slug}`),
      projectId: p.id,
    }), "It's running steadily again.");
  }
}

async function checkCrons(): Promise<void> {
  for (const p of listProjects()) {
    const crons = listCrons(p.id);
    if (crons.length === 0) continue;
    const live = await liveCrons(p.slug);
    for (const c of crons) {
      const job = live.get(c.name);
      if (!job) continue;
      const key = `cron:${p.slug}:${c.name}`;
      await apply(cronVerdict(job.lastResult, job.lastRun, !!openIncident(key)), key, () => ({
        title: `Cron job failed: ${p.slug}/${c.name}`,
        detail: `The last run ended with ${job.lastExitStatus !== null && job.lastExitStatus !== 0 ? `exit code ${job.lastExitStatus}` : job.lastResult}.`,
        link: panelUrl(`/projects/${p.slug}/crons/${c.name}`),
        projectId: p.id,
      }), "The next run succeeded.");
    }
  }
}

async function checkCertificates(): Promise<void> {
  for (const p of listProjects()) {
    for (const d of listDomains(p.id).filter((d) => d.status === "active")) {
      const cert = await checkCertificate(d.host);
      const key = `cert:${d.host}`;
      const liveFor = d.verifiedAt ? now() - d.verifiedAt : 0;
      await apply(certVerdict(cert.ok ? { ok: true, daysLeft: cert.daysLeft } : { ok: false, reason: cert.reason }, liveFor, !!openIncident(key)), key, () => ({
        title: `Certificate problem: ${d.host}`,
        detail: cert.ok
          ? `It expires in ${cert.daysLeft} days and hasn't been renewed. Check that the domain still points at this server.`
          : cert.reason === "issuing"
            ? "No certificate after 15 minutes. Check the domain's DNS (and any proxy in front of it)."
            : cert.reason === "expired"
              ? "The certificate has expired. Check that the domain still points at this server."
              : "Port 443 didn't answer for this domain.",
        link: panelUrl(`/projects/${p.slug}/domains`),
        projectId: p.id,
      }), cert.ok ? `Valid again (${cert.issuer}, ${cert.daysLeft} days left).` : "");
    }
  }
}

/** One round of checks; each check fails on its own without stopping the others. */
/** Starts the daily backup at its hour (in the background: it can take a while), and flags apps without a recent backup. */
async function checkBackups(): Promise<void> {
  void scheduledTick().catch((err) => console.error("monitor: scheduled backup failed:", (err as Error).message));
  const overdue = new Set(overdueSlugs());
  for (const p of backupProjects()) {
    const key = `backup-overdue:${p.slug}`;
    if (overdue.has(p.slug)) await raise(key, { title: `No backup in over a day: ${p.slug}`, detail: "The last successful backup is more than 26 hours old.", link: panelUrl(`/projects/${p.slug}/backups`), projectId: p.id });
    else if (openIncident(key)) await resolve(key, "A backup worked again.");
  }
}

export async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    for (const [name, check] of [["disk", checkDisk], ["servers", checkServers], ["apps", checkApps], ["crons", checkCrons]] as const) {
      await check().catch((err) => console.error(`monitor: ${name} check failed:`, (err as Error).message));
    }
    await checkBackups().catch((err) => console.error("monitor: backup check failed:", (err as Error).message));
    await sampleMetrics().catch((err) => console.error("monitor: metrics failed:", (err as Error).message));
    await recheckPendingDomains().catch((err) => console.error("monitor: domain check failed:", (err as Error).message));
    if (Date.now() - state.lastCertCheck > CERT_EVERY_MS) {
      state.lastCertCheck = Date.now();
      await checkCertificates().catch((err) => console.error("monitor: certificate check failed:", (err as Error).message));
    }
    if (updateCheckDue(state.lastUpdateCheck)) {
      state.lastUpdateCheck = Date.now();
      await checkForUpdates().catch((err) => console.error("monitor: update check failed:", (err as Error).message));
    }
  } finally {
    state.running = false;
  }
}

export function startMonitor(): void {
  if (state.started) return;
  state.started = true;
  db(); // run migrations before the first tick
  markInterrupted();
  try {
    configureAlerts({ serverName: boxConfig().panelHost });
  } catch {
    // no box config (dev): keep the default name
  }
  // Deployments still waiting when the panel stopped start again.
  resumeDeployments();
  setTimeout(() => void tick(), 15_000);
  setInterval(() => void tick(), TICK_MS).unref();
  console.log("layer-panel monitor started");
}
