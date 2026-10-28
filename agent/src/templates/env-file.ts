import { assertEnvKey, assertInt, assertLine, ValidationError } from "@layer/protocol";

const MAX_VARS = 500;
const MAX_VALUE = 32 * 1024;

/**
 * Validates the panel's env vars. Keys must be conventional env names; values
 * are single lines (a newline would start a new KEY= line in the file).
 */
export function assertEnvVars(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("vars", "must be an object of KEY: value");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_VARS) {
    throw new ValidationError("vars", `at most ${MAX_VARS} variables`);
  }
  const vars: Record<string, string> = {};
  for (const [key, val] of entries) {
    assertEnvKey(key, `vars.${key}`);
    vars[key] = assertLine(val, `vars.${key}`, MAX_VALUE);
  }
  return vars;
}

/**
 * Renders an EnvironmentFile= for systemd. Every value is double-quoted, and
 * inside double quotes systemd only treats \ and " specially: $, %, `, #, '
 * and leading/trailing spaces are kept as written (verified on systemd 255).
 */
export function renderEnvFile(vars: Record<string, string>): string {
  const lines = ["# Managed by layer-agent. Edit env vars in the panel."];
  for (const [key, value] of Object.entries(vars)) {
    lines.push(`${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
  }
  return lines.join("\n") + "\n";
}

/** The per-color env file. Loaded after app.env, so these always win. */
export function renderColorEnv(port: number): string {
  assertInt(port, "port", 1024, 65535);
  return [
    "# Managed by layer-agent.",
    `PORT=${port}`,
    // Next.js and Express examples read HOSTNAME; Astro's Node adapter and
    // Nuxt/Nitro read HOST. Both, so nothing binds to localhost/IPv6 only.
    "HOSTNAME=127.0.0.1",
    "HOST=127.0.0.1",
    "NODE_ENV=production",
    "",
  ].join("\n");
}

export function parseColorEnvPort(content: string): number | null {
  const match = /^PORT=(\d{1,5})$/m.exec(content);
  return match ? Number(match[1]) : null;
}
