// Works out how to build and run a project from the files at its root folder:
// framework, package manager, build command, how to start it (or which folder
// to serve statically) and which Node version it wants. Pure: the caller
// fetches the files (from GitHub) and every result can be overridden in the UI.

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export type Framework =
  | "nextjs"
  | "nuxt"
  | "astro-node"
  | "astro-static"
  | "react-router"
  | "remix"
  | "vite"
  | "cra"
  | "node-server"
  | "static-html"
  | "unknown";

export type Runtime =
  | { kind: "node"; exec: string[]; writablePaths: string[]; healthPath: string }
  | { kind: "static"; outputDir: string; spa: boolean };

export interface Detected {
  framework: Framework;
  label: string;
  packageManager: PackageManager;
  /** What the project asks for (".nvmrc" etc.); resolve with resolveNodeVersion. null: use the default LTS. */
  nodeRange: string | null;
  nodeSource: ".nvmrc" | ".node-version" | "engines.node" | null;
  buildCommand: string | null;
  runtime: Runtime;
  warnings: string[];
}

/** path → file content (for the files we read) or true (it exists). */
export type ProjectFiles = Record<string, string | true>;

/** Files whose content detection reads; everything else only needs to exist. */
export const FILES_TO_READ = ["package.json", ".nvmrc", ".node-version"] as const;
export const FILES_TO_CHECK = [
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  ".yarnrc.yml",
  "index.html",
] as const;

interface PackageJson {
  packageManager?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}

const LABELS: Record<Framework, string> = {
  nextjs: "Next.js",
  nuxt: "Nuxt",
  "astro-node": "Astro (server)",
  "astro-static": "Astro (static)",
  "react-router": "React Router",
  remix: "Remix",
  vite: "Vite",
  cra: "Create React App",
  "node-server": "Node.js server",
  "static-html": "Static HTML",
  unknown: "Node.js",
};

/** "nextjs" → "Next.js" (unknown values come back as they are). */
export const frameworkLabel = (framework: string) => LABELS[framework as Framework] ?? framework;

const content = (files: ProjectFiles, path: string) => (typeof files[path] === "string" ? (files[path] as string) : null);

export function detectPackageManager(files: ProjectFiles, pkg: PackageJson | null): PackageManager {
  // The packageManager field (corepack) wins: "pnpm@9.1.0" → pnpm.
  const declared = /^(npm|yarn|pnpm|bun)@/.exec(pkg?.packageManager ?? "")?.[1];
  if (declared) return declared as PackageManager;
  if (files["pnpm-lock.yaml"]) return "pnpm";
  if (files["yarn.lock"]) return "yarn";
  if (files["bun.lock"] || files["bun.lockb"]) return "bun";
  return "npm";
}

export const runScript = (pm: PackageManager, script: string) => `${pm} run ${script}`;

/**
 * A start script that is just `node <file> [args]` runs as node directly; npm
 * as a process manager writes to a home folder the sandbox keeps read-only,
 * and adds a slow extra process.
 */
export function startCommand(pkg: PackageJson): { exec: string[]; warning?: string } {
  const script = pkg.scripts?.start?.trim();
  if (script && /^node\s+[^;&|`$<>()'"\\]+$/.test(script)) return { exec: script.split(/\s+/) };
  if (pkg.main) return { exec: ["node", pkg.main], ...(script ? { warning: `The start script "${script}" isn't a plain node command, so the "main" file runs instead. Set a start command if that's wrong.` } : {}) };
  if (script) return { exec: ["npm", "start"], warning: `The start script "${script}" runs through npm. A start command that begins with node starts faster and more reliably.` };
  return { exec: ["node", "index.js"], warning: "No start script or main file, so index.js is assumed. Set a start command." };
}

export function detect(files: ProjectFiles): Detected {
  const warnings: string[] = [];
  let pkg: PackageJson | null = null;
  const raw = content(files, "package.json");
  if (raw !== null) {
    try {
      pkg = JSON.parse(raw) as PackageJson;
    } catch {
      warnings.push("package.json isn't valid JSON.");
    }
  }
  const pm = detectPackageManager(files, pkg);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const has = (name: string) => name in deps;
  const build = pkg?.scripts?.build ? runScript(pm, "build") : null;

  let nodeRange: string | null = null;
  let nodeSource: Detected["nodeSource"] = null;
  for (const [file, source] of [[".nvmrc", ".nvmrc"], [".node-version", ".node-version"]] as const) {
    const value = content(files, file)?.split("\n")[0]?.trim();
    if (value) {
      nodeRange = value;
      nodeSource = source;
      break;
    }
  }
  if (!nodeRange && pkg?.engines?.node) {
    nodeRange = pkg.engines.node;
    nodeSource = "engines.node";
  }

  const node = (exec: string[], writablePaths: string[] = []): Runtime => ({ kind: "node", exec, writablePaths, healthPath: "/" });
  const result = (framework: Framework, runtime: Runtime, buildCommand = build): Detected => ({
    framework,
    label: LABELS[framework],
    packageManager: pm,
    nodeRange,
    nodeSource,
    buildCommand,
    runtime,
    warnings,
  });

  if (!pkg) {
    if (files["index.html"]) return result("static-html", { kind: "static", outputDir: ".", spa: false }, null);
    warnings.push("No package.json or index.html at the root folder. Check the root directory setting.");
    return result("unknown", node(["node", "index.js"]), null);
  }

  if (has("next")) return result("nextjs", node(["node", "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1"], [".next/cache"]));
  if (has("nuxt")) return result("nuxt", node(["node", ".output/server/index.mjs"]));
  if (has("astro")) {
    return has("@astrojs/node")
      ? result("astro-node", node(["node", "dist/server/entry.mjs"]))
      : result("astro-static", { kind: "static", outputDir: "dist", spa: false });
  }
  if (has("@react-router/serve") || has("@react-router/dev")) {
    return result("react-router", node(["node", "node_modules/@react-router/serve/bin.js", "build/server/index.js"]));
  }
  if (has("@remix-run/serve") || has("@remix-run/dev")) {
    return result("remix", node(["node", "node_modules/@remix-run/serve/dist/cli.js", "build/server/index.js"]));
  }
  if (has("react-scripts")) return result("cra", { kind: "static", outputDir: "build", spa: true });
  if (has("vite") && !pkg.scripts?.start) return result("vite", { kind: "static", outputDir: "dist", spa: true });

  const start = startCommand(pkg);
  if (start.warning) warnings.push(start.warning);
  const isServer = ["express", "fastify", "hono", "@hono/node-server", "koa", "@nestjs/core", "h3", "polka"].some(has);
  return result(isServer || pkg.scripts?.start ? "node-server" : "unknown", node(start.exec));
}
