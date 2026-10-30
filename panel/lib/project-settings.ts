// Parsing and validating the project settings form. The rules match what the
// agent enforces, so mistakes show up in the form, not as a failed deploy.
import type { Runtime } from "./detect";

export interface SettingsInput {
  branch: string;
  installCommand: string | null;
  buildCommand: string | null;
  runtime: Runtime;
  nodeVersion: string;
  memoryMb: number;
  /** Absent when the form has no env editor (settings after the first deploy): keep what's saved. */
  env?: Record<string, string>;
}

export type SettingsResult = { ok: true; value: SettingsInput } | { ok: false; errors: Record<string, string> };

const NODE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const BRANCH = /^(?!\/|.*\/\/|.*\.\.|.*\/$|.*\.lock$)[A-Za-z0-9._\/-]{1,200}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const REL_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const HEALTH_PATH = /^\/[A-Za-z0-9._~\/?=&%+-]{0,255}$/;
const SAFE_ARG = /^[^\s\u0000-\u001f\u007f]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** "node server.js --port 3" → ["node", "server.js", "--port", "3"]; the agent runs it without a shell. */
export function parseStartCommand(command: string): string[] | string {
  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) return "Enter a start command, like node server.js.";
  if (!["node", "npm", "npx"].includes(argv[0]!)) return "The start command must begin with node, npm or npx (it runs on the project's Node version).";
  if (!argv.every((a) => SAFE_ARG.test(a) && a !== ";")) return "The start command can't contain control characters or a bare ;.";
  return argv;
}

const DOTENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** KEY=VALUE lines (a pasted .env): comments, `export ` and surrounding quotes are handled. */
export function parseDotEnv(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = DOTENV_LINE.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, "");
    vars[m[1]!] = value;
  }
  return vars;
}

/** The line numbers (from 1) that parseDotEnv leaves out: not blank, not a comment, not KEY=VALUE. */
export function badDotEnvLines(content: string): number[] {
  return content.split(/\r?\n/).flatMap((raw, i) => {
    const line = raw.trim();
    return line && !line.startsWith("#") && !DOTENV_LINE.test(line) ? [i + 1] : [];
  });
}

/** Variables as .env lines that parseDotEnv reads back the same: values it would trim, cut at " #" or unquote go in double quotes. */
export function formatDotEnv(vars: [string, string][]): string {
  return vars.map(([key, value]) => `${key}=${value !== value.trim() || /\s#|^(['"]).*\1$/.test(value) ? `"${value}"` : value}`).join("\n");
}

export function parseSettings(form: FormData): SettingsResult {
  const errors: Record<string, string> = {};

  const branch = text(form, "branch");
  if (!BRANCH.test(branch)) errors.branch = "Enter a branch name like main.";

  const optionalCommand = (name: string) => {
    const value = text(form, name);
    if (!value) return null;
    if (CONTROL.test(value) || value.length > 1000) errors[name] = "Use a single line of at most 1000 characters.";
    return value;
  };
  const installCommand = optionalCommand("installCommand");
  const buildCommand = optionalCommand("buildCommand");

  let runtime: Runtime;
  if (text(form, "runtime") === "static") {
    const outputDir = text(form, "outputDir") || ".";
    if (outputDir !== "." && (!REL_PATH.test(outputDir) || outputDir.split("/").some((s) => s === "." || s === ".."))) {
      errors.outputDir = "Enter a folder inside the project, like dist.";
    }
    runtime = { kind: "static", outputDir, spa: form.get("spa") === "on" };
  } else {
    const exec = parseStartCommand(text(form, "startCommand"));
    if (typeof exec === "string") errors.startCommand = exec;
    const healthPath = text(form, "healthPath") || "/";
    if (!HEALTH_PATH.test(healthPath)) errors.healthPath = "Enter a path starting with /, like /api/health.";
    const writable = text(form, "writablePaths")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (writable.some((p) => !REL_PATH.test(p) || p.split("/").some((s) => s === "." || s === ".."))) {
      errors.writablePaths = "Use folders inside the project, separated by commas, like .next/cache.";
    }
    runtime = { kind: "node", exec: typeof exec === "string" ? [] : exec, writablePaths: writable, healthPath };
  }

  const nodeVersion = text(form, "nodeVersion");
  if (!NODE_VERSION.test(nodeVersion)) errors.nodeVersion = "Enter an exact Node version, like 24.13.1.";

  const memoryMb = Number(text(form, "memoryMb"));
  if (!Number.isInteger(memoryMb) || memoryMb < 128 || memoryMb > 16384) errors.memoryMb = "Use a whole number from 128 to 16384.";

  let env: Record<string, string> | undefined;
  if (form.has("env")) {
    const parsed = parseEnvVars(form.get("env"));
    if (parsed.ok) env = parsed.env;
    else errors.env = parsed.error;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { branch, installCommand, buildCommand, runtime, nodeVersion, memoryMb, ...(env ? { env } : {}) } };
}

/** The env editor's hidden JSON field: {"NAME": "value"}. */
export function parseEnvVars(raw: FormDataEntryValue | null): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  let env: Record<string, string>;
  try {
    const parsed = JSON.parse(String(raw ?? "{}")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    env = parsed as Record<string, string>;
  } catch {
    return { ok: false, error: "The environment variables couldn't be read. Reload and try again." };
  }
  const badKey = Object.keys(env).find((k) => !ENV_KEY.test(k));
  if (badKey !== undefined) return { ok: false, error: `"${badKey}" isn't a valid name: use A-Z, 0-9 and _, not starting with a digit.` };
  const badValue = Object.entries(env).find(([, v]) => typeof v !== "string" || CONTROL.test(v) || v.length > 32768);
  if (badValue) return { ok: false, error: `${badValue[0]}: values must be a single line (paste multi-line secrets base64-encoded).` };
  if (Object.keys(env).length > 500) return { ok: false, error: "At most 500 variables." };
  return { ok: true, env };
}
