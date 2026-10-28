// Prints a rendered app unit to stdout. Used by the Day 1 spike.
//   node agent/scripts/render-unit.ts --slug hello --node 24.11.0 \
//     --write .next/cache -- node node_modules/next/dist/bin/next start -H 127.0.0.1
import { parseArgs } from "node:util";
import { renderAppUnit } from "../src/templates/app-unit.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    slug: { type: "string" },
    node: { type: "string" },
    memory: { type: "string", default: "512" },
    cpu: { type: "string", default: "100" },
    write: { type: "string", multiple: true, default: [] },
  },
});

process.stdout.write(
  renderAppUnit({
    slug: values.slug ?? "",
    nodeVersion: values.node ?? "",
    exec: positionals,
    memoryMaxMb: Number(values.memory),
    cpuQuotaPercent: Number(values.cpu),
    writablePaths: values.write,
  }),
);
