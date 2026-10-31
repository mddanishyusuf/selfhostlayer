// The integrations catalog's bookkeeping for scripts/publish-catalog.sh. Reads
// the catalog (catalog.json) on stdin.
//   node scripts/catalog-feed.ts add <build.json> <tarball-url> <catalog-url> <notes> <min-panel>
//        the catalog with this version on top of its app (the newest 10 of each
//        app stay), checked as every server will check it. build.json is what
//        scripts/build-catalog.ts printed. Fails unless the version is new and
//        newer than the app's newest.
//   node scripts/catalog-feed.ts remove <app>        the catalog without that app
//   node scripts/catalog-feed.ts versions <app>      the app's versions it lists, one a line
//   node scripts/catalog-feed.ts has <app> <version> fails unless it lists that version
import { readFileSync } from "node:fs";
import { parseCatalog } from "../agent/src/actions/catalog.ts";
import { isNewer } from "../packages/protocol/src/version.ts";

const KEEP = 10;

interface Version {
  version: string;
  date: string;
  notes: string | null;
  minPanel?: string;
  tarball: { url: string; sha256: string };
  manifest: { id: string; version: string };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const catalog = JSON.parse(readFileSync(0, "utf8")) as { apps: { id: string; versions: Version[] }[] };
const [command, ...args] = process.argv.slice(2);
const versionsOf = (app: string) => catalog.apps.find((a) => a.id === app)?.versions ?? [];

if (command === "add" && args.length === 5) {
  const [buildFile, url, catalogUrl, notes, minPanel] = args as [string, string, string, string, string];
  const build = JSON.parse(readFileSync(buildFile, "utf8")) as { sha256: string; manifest: Version["manifest"] };
  const { id, version } = build.manifest;
  const listed = versionsOf(id);
  if (listed.some((v) => v.version === version)) fail(`${id} ${version} is already in the catalog; a version never changes, so bump it in layer.yaml and package.json`);
  if (listed[0] && !isNewer(version, listed[0].version)) fail(`${id} ${version} isn't newer than ${listed[0].version}, the newest in the catalog`);
  const entry: Version = {
    version,
    date: new Date().toISOString().slice(0, 10),
    notes: notes.trim() || null,
    ...(minPanel ? { minPanel } : {}),
    tarball: { url, sha256: build.sha256 },
    manifest: build.manifest,
  };
  const apps = catalog.apps.some((a) => a.id === id)
    ? catalog.apps.map((a) => (a.id === id ? { id, versions: [entry, ...a.versions].slice(0, KEEP) } : a))
    : [...catalog.apps, { id, versions: [entry] }];
  const text = JSON.stringify({ apps }, null, 2);
  // The servers read it with this; a catalog they can't read stops every install.
  try {
    parseCatalog(text, catalogUrl);
  } catch (err) {
    fail(`the servers couldn't read this catalog: ${(err as Error).message}`);
  }
  console.log(text);
} else if (command === "remove" && args.length === 1) {
  if (!catalog.apps.some((a) => a.id === args[0])) fail(`the catalog doesn't list ${args[0]}`);
  console.log(JSON.stringify({ apps: catalog.apps.filter((a) => a.id !== args[0]) }, null, 2));
} else if (command === "versions" && args.length === 1) {
  for (const v of versionsOf(args[0]!)) console.log(v.version);
} else if (command === "has" && args.length === 2) {
  if (!versionsOf(args[0]!).some((v) => v.version === args[1])) fail(`the catalog doesn't list ${args[0]} ${args[1]}`);
} else {
  fail("usage: catalog-feed.ts add <build.json> <tarball-url> <catalog-url> <notes> <min-panel> | remove <app> | versions <app> | has <app> <version>");
}
