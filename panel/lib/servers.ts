// Servers: other servers this panel deploys to (PLAN-SERVERS.md). Each runs
// an agent-only install; the panel reaches its agent over SSH as layer-link,
// whose key is locked to one command, a pipe to the agent's socket. So a call
// to another server is the same JSON line protocol, through ssh's stdin and
// stdout. One multiplexed connection per server (ControlMaster); the host key
// is pinned at the first connection.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { boxConfig } from "./box";
import { config } from "./config";
import { db, now } from "./db";

export interface Server {
  id: number;
  name: string;
  /** Where the panel's SSH goes (an IP or a host name). */
  host: string;
  port: number;
  /** What it said about itself at the last check (its public IP, version, OS…). */
  info: ServerInfo | null;
  /** When it last answered, and when it was last asked. */
  seenAt: number | null;
  checkedAt: number | null;
  error: string | null;
  createdAt: number;
}

export interface ServerInfo {
  agentVersion: string;
  hostname: string;
  os: { name: string };
  arch: string;
  cpus: number;
  memoryMb: { total: number; available: number };
  diskGb: { total: number; free: number };
  publicIp?: string;
  appsDomain?: string;
}

interface Row {
  id: number;
  name: string;
  host: string;
  port: number;
  info: string | null;
  seen_at: number | null;
  checked_at: number | null;
  error: string | null;
  created_at: number;
}

const fromRow = (r: Row): Server => ({
  id: r.id,
  name: r.name,
  host: r.host,
  port: r.port,
  info: r.info ? (JSON.parse(r.info) as ServerInfo) : null,
  seenAt: r.seen_at,
  checkedAt: r.checked_at,
  error: r.error,
  createdAt: r.created_at,
});

export const listServers = (): Server[] => (db().prepare("SELECT * FROM servers ORDER BY id").all() as unknown as Row[]).map(fromRow);
export function getServer(id: number): Server | null {
  const r = db().prepare("SELECT * FROM servers WHERE id = ?").get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$|^\d{1,3}(\.\d{1,3}){3}$/i;

export function addServer(name: string, host: string, port = 22): Server {
  if (!name.trim() || name.length > 40) throw new Error("Give it a name, up to 40 characters.");
  if (!HOST.test(host) || host.length > 253) throw new Error("The server's address: an IP like 203.0.113.7, or a host name.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The SSH port: 22 unless you changed it.");
  if (listServers().some((s) => s.host === host)) throw new Error("That server is added already.");
  const id = Number(db().prepare("INSERT INTO servers (name, host, port, created_at) VALUES (?, ?, ?, ?)").run(name.trim(), host, port, now()).lastInsertRowid);
  return getServer(id)!;
}

export function removeServer(id: number): void {
  if ((db().prepare("SELECT COUNT(*) AS n FROM projects WHERE server_id = ?").get(id) as { n: number }).n) throw new Error("Projects still run there: delete or move them first.");
  db().prepare("DELETE FROM servers WHERE id = ?").run(id);
}

export function recordCheck(id: number, result: { info: ServerInfo } | { error: string }): void {
  if ("info" in result) db().prepare("UPDATE servers SET info = ?, seen_at = ?, checked_at = ?, error = NULL WHERE id = ?").run(JSON.stringify(result.info), now(), now(), id);
  else db().prepare("UPDATE servers SET checked_at = ?, error = ? WHERE id = ?").run(now(), result.error.slice(0, 300), id);
}

// ------------------------------------------------------------- the panel's key

const sshDir = () => join(config.dataDir, "ssh");
const keyFile = () => join(sshDir(), "id_ed25519");

/** The panel's SSH key, made the first time: the private half never leaves this server. */
export function panelPublicKey(): string {
  const dir = sshDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(keyFile())) {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "layer-panel", "-f", keyFile()], { stdio: "ignore" });
  }
  return readFileSync(`${keyFile()}.pub`, "utf8").trim();
}

/** ssh's options: the panel's own key and known hosts (one file per server), no config of anyone else's. */
function sshArgs(s: Server): string[] {
  const dir = sshDir();
  mkdirSync(join(dir, "control"), { recursive: true, mode: 0o700 });
  return [
    "-F", "/dev/null",
    "-T",
    "-i", keyFile(),
    "-p", String(s.port),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", `UserKnownHostsFile=${join(dir, `known_hosts-${s.id}`)}`,
    // The first connection learns the host key; after that, a different one is refused.
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(dir, "control", `${s.id}`)}`,
    "-o", "ControlPersist=600",
    `layer-link@${s.host}`,
  ];
}

/** A stream to the server's agent: ssh's stdin and stdout (the key's forced command is the pipe). */
export function sshTransport(s: Server): () => Duplex {
  return () => {
    const child = spawn("ssh", sshArgs(s), { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    child.on("close", (code) => {
      if (code && code !== 0) stream.destroy(new Error(sshError(stderr, code)));
    });
    child.on("error", (err) => stream.destroy(err));
    stream.on("close", () => child.kill());
    return stream;
  };
}

/** What ssh said, in a sentence. */
function sshError(stderr: string, code: number): string {
  const line = stderr.trim().split("\n").filter((l) => !/^Warning: Permanently added/.test(l)).at(-1) ?? "";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) return "the server's host key changed since it was added: if you reinstalled it, remove and add it again";
  if (/Permission denied/i.test(line)) return "the server refused the panel's key: run the install command there again";
  if (/timed out|No route|Connection refused|Could not resolve/i.test(line)) return `can't reach it over SSH (${line.replace(/^ssh: /, "")})`;
  return line || `ssh exited ${code}`;
}

// ------------------------------------------------------------- routing

/** Which server the work in progress is for (a deploy, a page about a project): null is the panel's own. */
const scope = new AsyncLocalStorage<number | null>();
export const onServer = <T>(serverId: number | null, fn: () => Promise<T>): Promise<T> => scope.run(serverId, fn);
export const currentServer = (): number | null | undefined => scope.getStore();

/** A slug's server (its project's), or undefined for one the panel doesn't know. */
export function serverOfSlug(slug: string): number | null | undefined {
  const r = db().prepare("SELECT server_id FROM projects WHERE slug = ?").get(slug) as { server_id: number | null } | undefined;
  return r ? r.server_id : undefined;
}

// ------------------------------------------------------------- the install command

/**
 * What to run on the new server, as root: this panel's own release (the same
 * version as the panel, from its release feed, checked against the feed's
 * sha256), in agent-only mode with the panel's key.
 */
export function installCommand(release: { url: string; sha256: string; installer: { url: string; sha256: string } }, appsDomain?: string): string {
  const key = panelPublicKey();
  return [
    "cd /tmp",
    `curl -fsSL -o layer.tar.gz ${release.url}`,
    `curl -fsSL -o layer-install.sh ${release.installer.url}`,
    `echo "${release.sha256}  layer.tar.gz" | sha256sum -c -`,
    `echo "${release.installer.sha256}  layer-install.sh" | sha256sum -c -`,
    `bash layer-install.sh --from-tarball layer.tar.gz --agent-only --panel-key '${key}'${appsDomain ? ` --apps-domain ${appsDomain}` : ""}`,
  ].join(" && \\\n  ");
}

// ------------------------------------------------------------- per server

/** The address DNS must point at for a project on this server (null: the panel's own). */
export function serverIp(serverId: number | null): string {
  if (serverId === null) return boxConfig().publicIp;
  const s = getServer(serverId);
  return s?.info?.publicIp || s?.host || boxConfig().publicIp;
}

/** A new app's free address on its server: <slug>.<that server's apps domain>. */
export function freeHostOn(slug: string, serverId: number | null): string {
  if (serverId === null) return `${slug}.${boxConfig().appsDomain}`;
  const s = getServer(serverId);
  if (!s?.info?.appsDomain) throw new Error(`Check the connection to ${s?.name ?? "that server"} first: the panel doesn't know its addresses yet.`);
  return `${slug}.${s.info.appsDomain}`;
}

// ------------------------------------------------------------- files to and from a server

/** A staged snapshot from another server into a local file (backup.fetch's base64 chunks). */
export async function fetchStaged(serverId: number, file: string, dest: string): Promise<void> {
  const { agent } = await import("./agent");
  const out = createWriteStream(dest, { mode: 0o600, flags: "wx" });
  try {
    await agent("backup.fetch", { file }, { server: serverId, onChunk: (c) => out.write(Buffer.from(c, "base64")) });
  } finally {
    await new Promise<void>((done) => out.end(done));
  }
}

/** A local file into another server's restore folder, in pieces (backup.put), for restore or import there. */
export async function putFile(serverId: number, path: string, name: string): Promise<void> {
  const { agent } = await import("./agent");
  const fd = openSync(path, "r");
  try {
    const piece = Buffer.alloc(512 * 1024);
    let offset = 0;
    for (;;) {
      const n = readSync(fd, piece, 0, piece.length, offset);
      if (n === 0 && offset > 0) break;
      await agent("backup.put", { file: name, offset, data: piece.subarray(0, n).toString("base64") }, { server: serverId });
      offset += n;
      if (n === 0) break;
    }
  } finally {
    closeSync(fd);
  }
}
