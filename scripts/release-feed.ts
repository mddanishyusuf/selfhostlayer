// The update feed's bookkeeping for scripts/publish-release.sh. Reads the
// feed (releases.json) on stdin.
//   node scripts/release-feed.ts check <version>         fails unless the version is new and newer than the newest
//   node scripts/release-feed.ts last-commit             the commit the newest release was built from
//   node scripts/release-feed.ts add <version> <commit> <notes> <tarball-url> <tarball-sha256> <installer-url> <installer-sha256>
//                                                        the feed with this release on top (the newest 10 stay)
//   node scripts/release-feed.ts versions                the versions it lists, one a line
import { readFileSync } from "node:fs";
import { isNewer } from "../packages/protocol/src/version.ts";

const KEEP = 10;

interface Entry {
  version: string;
  date: string;
  commit?: string;
  notes: string | null;
  tarball: { url: string; sha256: string };
  installer: { url: string; sha256: string };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const feed = JSON.parse(readFileSync(0, "utf8")) as { releases: Entry[] };
const [command, ...args] = process.argv.slice(2);

function check(version: string) {
  const newest = feed.releases[0]?.version;
  if (feed.releases.some((r) => r.version === version)) fail(`${version} is already published; a release never changes, so publish a new version`);
  if (newest && !isNewer(version, newest)) fail(`${version} isn't newer than ${newest}, the newest release in the feed`);
}

if (command === "check" && args.length === 1) {
  check(args[0]!);
} else if (command === "last-commit") {
  console.log(feed.releases[0]?.commit ?? "");
} else if (command === "versions") {
  for (const r of feed.releases) console.log(r.version);
} else if (command === "add" && args.length === 7) {
  const [version, commit, notes, tarball, tarballSha, installer, installerSha] = args as [string, string, string, string, string, string, string];
  check(version);
  const entry: Entry = {
    version,
    date: new Date().toISOString().slice(0, 10),
    commit,
    notes: notes.trim() || null,
    tarball: { url: tarball, sha256: tarballSha },
    installer: { url: installer, sha256: installerSha },
  };
  console.log(JSON.stringify({ releases: [entry, ...feed.releases].slice(0, KEEP) }, null, 2));
} else {
  fail("usage: release-feed.ts check <version> | last-commit | versions | add <version> <commit> <notes> <tarball-url> <tarball-sha256> <installer-url> <installer-sha256>");
}
