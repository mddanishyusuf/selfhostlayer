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
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
// Any C0 control character or DEL. Newlines would let a value inject extra
// lines into a unit or env file.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const COLORS = ["blue", "green"] as const;
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
