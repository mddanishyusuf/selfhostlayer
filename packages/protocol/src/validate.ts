// Validators for every value that crosses the panel → agent boundary.
// The agent builds paths, unit files and Caddy files from these values, so
// each one is checked against a strict allowlist pattern, never a denylist.

export class ValidationError extends Error {
  field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

const SLUG = /^[a-z](?:[a-z0-9-]{0,29}[a-z0-9])$/;
const NODE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
// GitHub's own rules: owners are 1-39 of [A-Za-z0-9-] not starting with "-";
// repos are 1-100 of [A-Za-z0-9._-] and never "." or "..".
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEALTH_PATH = /^\/[A-Za-z0-9._~\/?=&%+-]{0,255}$/;
// Any C0 control character or DEL. Newlines would let a value inject extra
// lines into a unit or env file.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const COLORS = ["blue", "green"] as const;
export const PACKAGE_MANAGERS = ["npm", "yarn", "pnpm", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];
export type Color = (typeof COLORS)[number];

export function assertSlug(value: unknown, field = "slug"): string {
  if (typeof value !== "string" || !SLUG.test(value) || value.includes("--")) {
    throw new ValidationError(
      field,
      "must be 2-31 chars of a-z, 0-9 and single hyphens, starting with a letter",
    );
  }
  return value;
}

export function assertColor(value: unknown, field = "color"): Color {
  if (!COLORS.includes(value as Color)) {
    throw new ValidationError(field, "must be blue or green");
  }
  return value as Color;
}

export function assertNodeVersion(value: unknown, field = "nodeVersion"): string {
  if (typeof value !== "string" || !NODE_VERSION.test(value)) {
    throw new ValidationError(field, "must be an exact version like 24.11.0");
  }
  return value;
}

export function assertSha(value: unknown, field = "sha"): string {
  if (typeof value !== "string" || !SHA.test(value)) {
    throw new ValidationError(field, "must be 7-40 lowercase hex chars");
  }
  return value;
}

export function assertInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(field, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function assertEnvKey(value: unknown, field = "env key"): string {
  if (typeof value !== "string" || !ENV_KEY.test(value)) {
    throw new ValidationError(field, "must match [A-Z_][A-Z0-9_]*");
  }
  return value;
}

/** A single-line string: no newlines or other control characters. */
export function assertLine(value: unknown, field: string, maxLength = 4096): string {
  if (typeof value !== "string" || value.length > maxLength || CONTROL_CHARS.test(value)) {
    throw new ValidationError(field, `must be a single line of at most ${maxLength} chars`);
  }
  return value;
}

/** A path relative to a release dir, e.g. ".next/cache". No "..", no leading "/". */
export function assertRelativePath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new ValidationError(field, "must be a non-empty relative path");
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new ValidationError(field, "must be a relative path without '.' or '..' segments");
    }
  }
  return value;
}

/** Private files: at most this many per project, each and all together at most these sizes. */
export const PRIVATE_FILES = { max: 20, fileBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024 };

/**
 * A project's private files: [{ path, content }], each path relative to the
 * project's root (serviceAccountKey.json, config/firebase.json), once.
 */
export function assertPrivateFiles(value: unknown, field = "files"): { path: string; content: string }[] {
  if (!Array.isArray(value) || value.length > PRIVATE_FILES.max) throw new ValidationError(field, `must be a list of at most ${PRIVATE_FILES.max} files`);
  const seen = new Set<string>();
  let total = 0;
  return value.map((f: unknown, i) => {
    const file = (f ?? {}) as { path?: unknown; content?: unknown };
    const path = assertRelativePath(file.path, `${field}[${i}].path`);
    if (seen.has(path)) throw new ValidationError(`${field}[${i}].path`, `${path} is listed twice`);
    seen.add(path);
    if (typeof file.content !== "string") throw new ValidationError(`${field}[${i}].content`, "must be text");
    const bytes = Buffer.byteLength(file.content);
    if (bytes > PRIVATE_FILES.fileBytes) throw new ValidationError(`${field}[${i}].content`, `${path} is over ${PRIVATE_FILES.fileBytes / 1024} KB`);
    total += bytes;
    if (total > PRIVATE_FILES.totalBytes) throw new ValidationError(field, `all files together are over ${PRIVATE_FILES.totalBytes / 1024 ** 2} MB`);
    return { path, content: file.content };
  });
}

/** A lowercase hostname like example.com or app.example.internal. No wildcards or IPs. */
export function assertDomain(value: unknown, field = "domain"): string {
  if (typeof value !== "string" || value.length > 253) {
    throw new ValidationError(field, "must be a hostname of at most 253 chars");
  }
  const labels = value.split(".");
  if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL.test(l)) || /^\d+$/.test(labels.at(-1)!)) {
    throw new ValidationError(field, "must be a lowercase hostname like app.example.com");
  }
  return value;
}

/** An HTTP path for health checks, e.g. "/" or "/api/health?full=1". */
export function assertHealthPath(value: unknown, field = "healthPath"): string {
  if (typeof value !== "string" || !HEALTH_PATH.test(value)) {
    throw new ValidationError(field, "must be a path starting with / (letters, digits and ._~/?=&%+-)");
  }
  return value;
}

/** A full 40-char commit sha: builds pin an exact commit, never a branch name. */
export function assertFullSha(value: unknown, field = "sha"): string {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new ValidationError(field, "must be a full 40-char lowercase commit sha");
  }
  return value;
}

export function assertGithubOwner(value: unknown, field = "owner"): string {
  if (typeof value !== "string" || !GITHUB_OWNER.test(value)) {
    throw new ValidationError(field, "must be a GitHub user or organization name");
  }
  return value;
}

export function assertGithubRepo(value: unknown, field = "repo"): string {
  if (typeof value !== "string" || !GITHUB_REPO.test(value) || value === "." || value === "..") {
    throw new ValidationError(field, "must be a GitHub repository name");
  }
  return value;
}

export function assertPackageManager(value: unknown, field = "packageManager"): PackageManager {
  if (!PACKAGE_MANAGERS.includes(value as PackageManager)) {
    throw new ValidationError(field, `must be one of ${PACKAGE_MANAGERS.join(", ")}`);
  }
  return value as PackageManager;
}

/**
 * A shell command from the project's settings (custom install/build command).
 * It runs as the app's own user inside the build sandbox, like any npm script,
 * so it only has to be a single line.
 */
export function assertCommand(value: unknown, field: string): string {
  const command = assertLine(value, field, 1000).trim();
  if (!command) throw new ValidationError(field, "must not be empty");
  return command;
}
