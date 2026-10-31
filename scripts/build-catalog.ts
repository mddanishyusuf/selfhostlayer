// Builds a catalog app (an integration) into dist/catalog/<id>-<version>.tar.gz:
//   node scripts/build-catalog.ts <app>
// Reads catalog/<app>/layer.yaml and checks it with the same validator the
// agent uses (and its cron schedules with the panel's, which turns them into
// timers at install), runs the app's build (npm run build, which must fill dist/), and
// packs dist/ with layer.json (the manifest as JSON) under <id>-<version>/.
// Prints one JSON line: the file, its sha256 and the manifest, which is what
// its entry in catalog.json needs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { cronToCalendar } from "../panel/lib/cron.ts";
import { parseManifest } from "../packages/protocol/src/manifest.ts";

const app = process.argv[2] ?? "";
if (!/^[a-z][a-z0-9-]{0,30}$/.test(app)) {
  console.error("usage: node scripts/build-catalog.ts <app>   (a folder in catalog/)");
  process.exit(2);
}
const root = join(import.meta.dirname, "..");
const dir = join(root, "catalog", app);
if (!existsSync(join(dir, "layer.yaml"))) {
  console.error(`catalog/${app}/layer.yaml is missing`);
  process.exit(1);
}

const manifest = parseManifest(parse(readFileSync(join(dir, "layer.yaml"), "utf8")));
if (manifest.id !== app) throw new Error(`catalog/${app}/layer.yaml says its id is ${manifest.id}`);
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
if (pkg.version !== manifest.version) throw new Error(`package.json says ${pkg.version}, layer.yaml says ${manifest.version}: keep them the same`);
for (const c of manifest.cron) {
  try {
    cronToCalendar(c.schedule);
  } catch (err) {
    throw new Error(`cron ${c.name}: ${(err as Error).message}`);
  }
}

execFileSync("npm", ["run", "build", "--silent"], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
const dist = join(dir, "dist");
if (!existsSync(dist)) throw new Error(`npm run build didn't make catalog/${app}/dist`);

const name = `${app}-${manifest.version}`;
const stage = mkdtempSync(join(tmpdir(), "layer-catalog-"));
try {
  cpSync(dist, join(stage, name), { recursive: true });
  writeFileSync(join(stage, name, "layer.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const outDir = join(root, "dist", "catalog");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.tar.gz`);
  // No macOS extended attributes or AppleDouble files in the archive.
  execFileSync("tar", ["--no-xattrs", "-czf", file, "-C", stage, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  console.log(JSON.stringify({ file, sha256, manifest }));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
