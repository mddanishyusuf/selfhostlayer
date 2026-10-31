// The app manifest: the one place a catalog app (an integration) says what it
// needs. Authors write layer.yaml; the catalog build turns it into JSON
// (layer.json in the tarball, and the app's entry in catalog.json), so the box
// only ever reads JSON. Everything here ends up in unit files, env files and
// paths, so each value is checked against an allowlist, as in validate.ts.
import { assertEnvKey, assertHealthPath, assertInt, assertLine, assertRelativePath, assertSlug, ValidationError } from "./validate.ts";

export type ManifestEnv =
  /** Made once at install (32 random bytes, hex) and kept across updates. */
  | { generate: "secret" }
  /** Something the owner sets in the panel, with this default until then. */
  | { setting: string; default: string }
  /** A fixed value. */
  | { value: string };

export interface ManifestCron {
  name: string;
  /** systemd OnCalendar, as project cron jobs (checked by systemd at install). */
  schedule: string;
  /** Run in the release folder, as the app's user, like a project's cron command. */
  command: string;
}

export interface AppManifest {
  id: string;
  name: string;
  version: string;
  summary: string;
  runtime: {
    kind: "node";
    /** A major version ("24") or an exact one ("24.13.1"). */
    node: string;
    start: string[];
    health: string;
    writable: string[];
  };
  memory: { default: number; min: number };
  env: Record<string, ManifestEnv>;
  services: "sqlite"[];
  cron: ManifestCron[];
  backup: string[];
}

export const MANIFEST_SERVICES = ["sqlite"] as const;
/** The platform sets these; a manifest can't. */
const RESERVED_ENV = new Set(["PORT", "HOST", "NODE_ENV", "DATA_DIR", "PATH", "HOME", "USER", "REDIS_URL", "DATABASE_URL", "MONGODB_URI"]);
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;
const NODE = /^\d{2}(?:\.\d{1,3}\.\d{1,3})?$/;
const START_ARG = /^[A-Za-z0-9._/@=:,+-]{1,200}$/;
const SETTING = /^[a-z][A-Za-z0-9]{0,39}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function list(value: unknown, field: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError(field, "must be a list");
  if (value.length > max) throw new ValidationError(field, `must have at most ${max} entries`);
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(field, "must be text");
  return assertLine(value, field, max).trim();
}

function envSpec(value: unknown, field: string): ManifestEnv {
  if (!isObject(value)) throw new ValidationError(field, "must be { generate: secret }, { setting, default } or { value }");
  if (value.generate !== undefined) {
    if (value.generate !== "secret") throw new ValidationError(`${field}.generate`, 'must be "secret"');
    return { generate: "secret" };
  }
  if (value.setting !== undefined) {
    if (typeof value.setting !== "string" || !SETTING.test(value.setting)) throw new ValidationError(`${field}.setting`, "must be a name like fallbackUrl");
    return { setting: value.setting, default: value.default === undefined ? "" : assertLine(value.default, `${field}.default`, 2000) };
  }
  if (value.value !== undefined) return { value: assertLine(value.value, `${field}.value`, 2000) };
  throw new ValidationError(field, "must be { generate: secret }, { setting, default } or { value }");
}

/** A manifest from layer.yaml (parsed) or layer.json, checked; throws ValidationError naming the field. */
export function parseManifest(value: unknown): AppManifest {
  if (!isObject(value)) throw new ValidationError("manifest", "must be an object");
  const id = assertSlug(value.id, "id");
  if (typeof value.version !== "string" || !VERSION.test(value.version)) throw new ValidationError("version", "must be a version like 0.1.0");

  const runtime = value.runtime;
  if (!isObject(runtime)) throw new ValidationError("runtime", "must be an object");
  if (runtime.kind !== "node") throw new ValidationError("runtime.kind", 'must be "node"');
  const node = String(runtime.node ?? "");
  if (!NODE.test(node)) throw new ValidationError("runtime.node", 'must be a Node major version like "24" or an exact one like "24.13.1"');
  const start = list(runtime.start, "runtime.start", 20).map((arg, i) => {
    if (typeof arg !== "string" || !START_ARG.test(arg)) throw new ValidationError(`runtime.start[${i}]`, "must be a plain word (no spaces or shell characters)");
    return arg;
  });
  if (!start.length) throw new ValidationError("runtime.start", "must name the command that starts the app");
  const writable = list(runtime.writable, "runtime.writable", 10).map((p, i) => assertRelativePath(p, `runtime.writable[${i}]`));

  const memory = isObject(value.memory) ? value.memory : {};
  const min = assertInt(memory.min ?? 64, "memory.min", 32, 4096);
  const defaultMb = assertInt(memory.default ?? 256, "memory.default", min, 4096);

  const env: Record<string, ManifestEnv> = {};
  if (value.env !== undefined) {
    if (!isObject(value.env)) throw new ValidationError("env", "must map names to values");
    for (const [key, spec] of Object.entries(value.env)) {
      assertEnvKey(key, `env.${key}`);
      if (RESERVED_ENV.has(key)) throw new ValidationError(`env.${key}`, "is set by Self Host Layer");
      env[key] = envSpec(spec, `env.${key}`);
    }
  }

  const services = list(value.services, "services", 5).map((s, i) => {
    if (!(MANIFEST_SERVICES as readonly unknown[]).includes(s)) throw new ValidationError(`services[${i}]`, `must be one of: ${MANIFEST_SERVICES.join(", ")}`);
    return s as "sqlite";
  });

  const names = new Set<string>();
  const cron = list(value.cron, "cron", 10).map((c, i) => {
    if (!isObject(c)) throw new ValidationError(`cron[${i}]`, "must be { name, schedule, command }");
    const name = assertSlug(c.name, `cron[${i}].name`);
    if (names.has(name)) throw new ValidationError(`cron[${i}].name`, `${name} is listed twice`);
    names.add(name);
    return { name, schedule: text(c.schedule, `cron[${i}].schedule`, 100), command: text(c.command, `cron[${i}].command`, 1000) };
  });

  const backup = list(value.backup, "backup", 10).map((p, i) => assertRelativePath(p, `backup[${i}]`));

  return {
    id,
    name: text(value.name, "name", 60),
    version: value.version,
    summary: text(value.summary, "summary", 200),
    runtime: { kind: "node", node, start, health: assertHealthPath(runtime.health ?? "/", "runtime.health"), writable },
    memory: { default: defaultMb, min },
    env,
    services,
    cron,
    backup,
  };
}
