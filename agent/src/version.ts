// Which of two Self Host Layer versions is newer. No imports, so
// scripts/publish-release.sh can use it too (through scripts/release-feed.ts).
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Whether version a comes after b. Semver order when both are semver, so a
 * dev build (0.2.0-dev.abc1234) is behind its release (0.2.0) and ahead of the
 * one before (0.1.0); any other pair, like test builds named ci and ci-next,
 * counts as newer when they differ.
 */
export function isNewer(a: string, b: string): boolean {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return a !== b;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  if (!x[4] || !y[4]) return !x[4] && !!y[4];
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return q[i] === undefined;
    if (p[i] === q[i]) continue;
    const [m, n] = [/^\d+$/.test(p[i]!), /^\d+$/.test(q[i]!)];
    if (m && n) return Number(p[i]) > Number(q[i]);
    if (m !== n) return n; // numbers come before words
    return p[i]! > q[i]!;
  }
  return false;
}

/** Whether a server on `version` can take something that needs `minimum` or newer. Dev and test builds (not semver) can take anything. */
export function meetsMinimum(version: string, minimum: string): boolean {
  return !SEMVER.test(version) || !isNewer(minimum, version);
}
