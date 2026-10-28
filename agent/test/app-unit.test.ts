import { describe, expect, it } from "vitest";
import { renderAppUnit, type AppUnitInput } from "../src/templates/app-unit.ts";

const piqo: AppUnitInput = {
  slug: "piqo",
  nodeVersion: "24.11.0",
  exec: ["node", "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1"],
  memoryMaxMb: 512,
  cpuQuotaPercent: 100,
  writablePaths: [".next/cache"],
};

describe("renderAppUnit", () => {
  it("renders the Next.js unit", async () => {
    await expect(renderAppUnit(piqo)).toMatchFileSnapshot("./__snapshots__/app-piqo@.service");
  });

  it("never enables MemoryDenyWriteExecute (V8 JIT needs W+X memory)", () => {
    expect(renderAppUnit(piqo)).not.toMatch(/MemoryDenyWriteExecute/);
  });

  it("loads the color env file last so it wins over app env", () => {
    const unit = renderAppUnit(piqo);
    expect(unit.indexOf("/app.env")).toBeLessThan(unit.indexOf("/%i.env"));
  });

  it("resolves argv[0] to the pinned runtime", () => {
    const unit = renderAppUnit({ ...piqo, exec: ["npm", "start"] });
    expect(unit).toContain("ExecStart=/opt/layer/node/24.11.0/bin/npm start\n");
  });

  it("rejects binaries outside the pinned runtime", () => {
    for (const bin of ["/bin/sh", "sh", "bash", "../node", "yarn"]) {
      expect(() => renderAppUnit({ ...piqo, exec: [bin, "-c", "id"] })).toThrow(/argv\[0\]/);
    }
    expect(() => renderAppUnit({ ...piqo, exec: [] })).toThrow(/argv/);
  });

  it("quotes and escapes arguments for systemd", () => {
    const unit = renderAppUnit({
      ...piqo,
      exec: ["node", "server.js", "--name", 'my "app"', "100%", "$HOME", "a\\b"],
    });
    expect(unit).toContain(
      'ExecStart=/opt/layer/node/24.11.0/bin/node server.js --name "my \\"app\\"" "100%%" "$$HOME" "a\\\\b"\n',
    );
  });

  it("rejects arguments that could inject unit lines", () => {
    for (const arg of ["start\nUser=root", "a\rb", "", ";"]) {
      expect(() => renderAppUnit({ ...piqo, exec: ["node", arg] })).toThrow(/exec\[1\]/);
    }
  });

  it("validates every interpolated field", () => {
    expect(() => renderAppUnit({ ...piqo, slug: "../root" })).toThrow(/slug/);
    expect(() => renderAppUnit({ ...piqo, nodeVersion: "24\nUser=root" })).toThrow(/nodeVersion/);
    expect(() => renderAppUnit({ ...piqo, memoryMaxMb: 32 })).toThrow(/memoryMaxMb/);
    expect(() => renderAppUnit({ ...piqo, cpuQuotaPercent: 0 })).toThrow(/cpuQuotaPercent/);
    expect(() => renderAppUnit({ ...piqo, writablePaths: ["../../etc"] })).toThrow(/writablePaths/);
    expect(() => renderAppUnit({ ...piqo, writablePaths: ["/etc"] })).toThrow(/writablePaths/);
  });

  it("always makes data/ writable, even with no extra paths", () => {
    const unit = renderAppUnit({ ...piqo, writablePaths: undefined });
    expect(unit).toContain("ReadWritePaths=/srv/apps/piqo/data\n");
  });
});
