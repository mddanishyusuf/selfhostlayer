// Sites: one-click WordPress and Ghost (PLAN-SITES.md). A site is a project
// with source "site" and its engine in catalog_app; its deploys run the
// engine's own steps (deploySite), through the same queue, log and pages as
// any project. The owner's first password is kept encrypted until it's been
// seen, then forgotten.
import { randomBytes } from "node:crypto";
import { agent } from "./agent";
import { boxConfig, freeHost } from "./box";
import { decrypt, encrypt } from "./crypto";
import { db } from "./db";
import { addDomain } from "./domains";
import { nodeReleases } from "./node-releases";
import { createProject, listProjects, projectEnv, setProjectEnv, slugFor, slugTaken, type Project } from "./projects";

export type SiteEngine = "wordpress" | "ghost";

export const ENGINES: Record<SiteEngine, { name: string; about: string; memoryMb: number; adminPath: string }> = {
  wordpress: {
    name: "WordPress",
    about: "Websites, blogs and shops, with thousands of themes and plugins. Runs on PHP, with its own MariaDB database.",
    memoryMb: 512,
    adminPath: "/wp-admin/",
  },
  ghost: {
    name: "Ghost",
    about: "A fast, modern blog and newsletter, made for writing. Runs on Node, with its own MySQL 8 database.",
    memoryMb: 768,
    adminPath: "/ghost/",
  },
};

export interface Site {
  projectId: number;
  engine: SiteEngine;
  title: string;
  ownerName: string;
  ownerEmail: string;
  /** WordPress: Caddy serves /xmlrpc.php. */
  xmlrpc: boolean;
  /** The owner's first password, until it's been seen. */
  password: string | null;
  installed: boolean;
}

interface Row {
  project_id: number;
  engine: SiteEngine;
  title: string;
  owner_name: string;
  owner_email: string;
  xmlrpc: number;
  password_enc: string | null;
  installed: number;
}

const fromRow = (r: Row): Site => ({
  projectId: r.project_id,
  engine: r.engine,
  title: r.title,
  ownerName: r.owner_name,
  ownerEmail: r.owner_email,
  xmlrpc: r.xmlrpc === 1,
  password: r.password_enc ? decrypt(r.password_enc) : null,
  installed: r.installed === 1,
});

export function getSite(projectId: number): Site | null {
  const row = db().prepare("SELECT * FROM sites WHERE project_id = ?").get(projectId) as Row | undefined;
  return row ? fromRow(row) : null;
}

export const isSite = (p: Project) => p.source === "site";
export const engineOf = (p: Project): SiteEngine | null => (p.source === "site" && (p.catalogApp === "wordpress" || p.catalogApp === "ghost") ? p.catalogApp : null);
export const listSites = () => listProjects().filter(isSite);

function setSite(projectId: number, fields: Partial<Pick<Row, "password_enc" | "installed" | "xmlrpc" | "title">>): void {
  for (const [k, v] of Object.entries(fields)) db().prepare(`UPDATE sites SET ${k} = ? WHERE project_id = ?`).run(v, projectId);
}

/** The owner's password was shown: forget it. */
export const forgetPassword = (projectId: number) => setSite(projectId, { password_enc: null });
export const setXmlrpc = (projectId: number, on: boolean) => setSite(projectId, { xmlrpc: on ? 1 : 0 });

/** What Caddy never serves for a WordPress site (the agent's wordpressBlocks, the same list). */
export function wordpressBlocks(xmlrpc: boolean): string[] {
  return ["/wp-config.php", "/wp-config-sample.php", "/readme.html", "/license.txt", "/wp-content/uploads/*.php", "/wp-content/debug.log", ...(xmlrpc ? [] : ["/xmlrpc.php"])];
}

/** The newest Node the server has seen that Ghost supports (^22.23.1 || ^24.20.0): the newest 24. */
async function ghostNode(): Promise<string> {
  const releases = await nodeReleases();
  const v24 = releases.filter((r) => r.version.startsWith("24.")).map((r) => r.version);
  const ok = v24.find((v) => Number(v.split(".")[1]) >= 20);
  if (!ok) throw new Error("No Node 24.20 or newer is available for Ghost.");
  return ok;
}

export interface NewSite {
  engine: SiteEngine;
  name: string;
  title: string;
  ownerName: string;
  ownerEmail: string;
}

/** Makes the project and its site row; deploying it (trigger install) does the rest. */
export async function createSite(s: NewSite): Promise<Project> {
  const box = boxConfig();
  const slug = slugFor(s.name || s.title, slugTaken);
  const engine = ENGINES[s.engine];
  const project = createProject({
    slug,
    repoOwner: "",
    repoName: "",
    installationId: null,
    branch: "",
    rootDir: "",
    framework: s.engine === "ghost" ? "node-server" : "php",
    packageManager: "pnpm",
    nodeVersion: s.engine === "ghost" ? await ghostNode() : box.defaultNode,
    installCommand: s.engine === "ghost" ? "pnpm install --prod --frozen-lockfile" : null,
    buildCommand: null,
    runtime: s.engine === "ghost" ? { kind: "node", exec: ["node", "layer-ghost.js"], writablePaths: [], healthPath: "/ghost/api/admin/site/" } : { kind: "php", root: "wordpress" },
    domains: [freeHost(slug, box)],
    memoryMb: engine.memoryMb,
    autoDeploy: false,
    source: "site",
    catalogApp: s.engine,
  });
  addDomain(project.id, project.domains[0]!, "free", null, "active");
  db()
    .prepare("INSERT INTO sites (project_id, engine, title, owner_name, owner_email, xmlrpc, password_enc, installed) VALUES (?, ?, ?, ?, ?, 0, NULL, 0)")
    .run(project.id, s.engine, s.title, s.ownerName, s.ownerEmail);
  return project;
}

export interface SiteRun {
  p: Project;
  /** The deployment's id: its sha is a release (Ghost) or a marker (WordPress). */
  log: (text: string) => void;
  setStatus: (status: "fetching" | "installing" | "building" | "starting" | "switching", step?: "fetch" | "install" | "build" | "start" | "switch") => void;
  stream: (action: Parameters<typeof agent>[0], params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Where the site answers: the first of its domains. */
  url: string;
  serving: { domains: string[]; redirects: { from: string; to: string }[] };
  /** A version to install (an update), else the one installed, else the newest. */
  version: string | null;
}

/** Deploys a site: the first time installs it (and its owner), after that it's put back as it should be. Returns the color. */
export async function deploySite(r: SiteRun): Promise<{ color: "blue" | "green" | "php"; version: string | null; release: string | null }> {
  const site = getSite(r.p.id);
  if (!site) throw new Error("This site's settings are missing.");
  return site.engine === "wordpress" ? deployWordpress(r, site) : deployGhost(r, site);
}

async function deployWordpress(r: SiteRun, site: Site) {
  const { p } = r;
  r.setStatus("installing", "install");
  const status = await agent<{ installed: Record<string, boolean> }>("service.status", {});
  if (!status.installed.php) r.log("Installing PHP for the first WordPress site (a minute)…\n");
  await r.stream("service.install", { name: "php" });
  if (!status.installed.mysql) r.log("Installing MariaDB (a minute)…\n");
  await r.stream("service.install", { name: "mysql" });
  await agent("app.create", { slug: p.slug });
  await agent("mysql.add", { slug: p.slug });

  let version: string | null = null;
  if (!site.installed) {
    r.setStatus("fetching", "fetch");
    const fetched = await r.stream("wordpress.fetch", r.version ? { version: r.version } : {});
    version = String(fetched.version);
    r.log(`WordPress ${version}, checked against wordpress.org's sha1${fetched.cached ? " (already here)" : ""}\n`);
    r.setStatus("building", "build");
    const installed = await r.stream("wordpress.install", {
      slug: p.slug,
      version,
      url: r.url,
      title: site.title,
      adminUser: usernameFrom(site.ownerEmail),
      adminEmail: site.ownerEmail,
      memoryMaxMb: p.memoryMb,
    });
    setSite(p.id, { installed: 1, password_enc: encrypt(String(installed.adminPassword)) });
    r.log(`Installed, with ${site.ownerEmail}'s account. Its password is on the site's page, once.\n`);
  } else {
    r.setStatus("starting", "start");
    await agent("php.write", { slug: p.slug, root: "wordpress", private: ["wp-config.php"], memoryMaxMb: p.memoryMb });
    await agent("wordpress.config", { slug: p.slug, url: r.url });
  }
  r.setStatus("switching", "switch");
  await agent("proxy.set", { slug: p.slug, ...r.serving, php: true, block: wordpressBlocks(site.xmlrpc) });
  return { color: "php" as const, version, release: null };
}

/** wp-admin's username: the email's name part, cleaned. */
function usernameFrom(email: string): string {
  const name = email.split("@")[0]!.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return name.length >= 3 ? name : `owner-${randomBytes(2).toString("hex")}`;
}

async function deployGhost(r: SiteRun, site: Site) {
  const { p } = r;
  r.setStatus("installing", "install");
  const status = await agent<{ installed: boolean }>("mysql8.status", {});
  if (!status.installed) r.log("Installing MySQL 8 for the first Ghost site: Oracle's build, checked against its signature (a few minutes, once)…\n");
  await r.stream("service.install", { name: "mysql8" });
  await agent("app.create", { slug: p.slug });
  await agent("mysql8.add", { slug: p.slug });
  // Ghost's address comes from its env; the rest of its env is the owner's.
  setProjectEnv(p.id, { ...projectEnv(p.id), url: r.url });
  await agent("env.write", { slug: p.slug, vars: projectEnv(p.id) });
  const node = await agent<{ installed: boolean }>("node.install", { version: p.nodeVersion });
  r.log(`Node ${p.nodeVersion}${node.installed ? " (installed now)" : ""}\n`);

  r.setStatus("fetching", "fetch");
  const fetched = await r.stream("ghost.fetch", { slug: p.slug, ...(r.version ? { version: r.version } : {}) });
  const release = String(fetched.release);
  const version = String(fetched.version);
  r.log(`Ghost ${version}, checked against the npm registry's integrity hash\n`);
  r.setStatus("building", "build");
  await r.stream("build.run", { slug: p.slug, sha: release, nodeVersion: p.nodeVersion, packageManager: "pnpm", installCommand: p.installCommand, memoryMb: 2048, timeoutSec: 2400 });

  r.setStatus("starting", "start");
  await agent("unit.write", { slug: p.slug, nodeVersion: p.nodeVersion, exec: ["node", "layer-ghost.js"], writablePaths: [], memoryMaxMb: p.memoryMb });
  const unit = await agent<{ live: "blue" | "green" | null }>("unit.status", { slug: p.slug });
  const idle: "blue" | "green" = unit.live === "blue" ? "green" : "blue";
  // Ghost migrates its database when it starts: two versions mustn't share it, so the old one stops first.
  if (unit.live) await agent("unit.stop", { slug: p.slug, color: unit.live });
  await agent("release.point", { slug: p.slug, color: idle, sha: release });
  r.log(`Starting Ghost on ${idle}…\n`);
  try {
    await agent("unit.start", { slug: p.slug, color: idle, healthPath: "/ghost/api/admin/site/", timeoutSec: 240 });
  } catch (err) {
    if (unit.live) await agent("unit.start", { slug: p.slug, color: unit.live, healthPath: "/ghost/api/admin/site/", timeoutSec: 240 }).catch(() => {});
    throw err;
  }
  if (!site.installed) {
    const setup = await agent<{ password: string }>("ghost.setup", { slug: p.slug, color: idle, url: r.url, title: site.title, name: site.ownerName, email: site.ownerEmail });
    setSite(p.id, { installed: 1, password_enc: encrypt(setup.password) });
    r.log(`The owner's account is made (${site.ownerEmail}). Its password is on the site's page, once.\n`);
  }
  r.setStatus("switching", "switch");
  await agent("proxy.set", { slug: p.slug, ...r.serving, color: idle });
  return { color: idle, version, release };
}
