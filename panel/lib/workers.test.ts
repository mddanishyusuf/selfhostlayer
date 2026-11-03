import { describe, expect, it } from "vitest";
import { scriptSuggestions, validateWorker } from "./workers";

describe("validateWorker", () => {
  it("cleans a worker up", () => {
    expect(validateWorker({ name: " queue ", command: "node   worker.js", memoryMb: 512 })).toEqual({
      ok: true,
      value: { name: "queue", command: "node worker.js", exec: ["node", "worker.js"], memoryMb: 512 },
    });
  });

  it("says what's wrong with each field", () => {
    const v = validateWorker({ name: "Queue 1", command: "bash worker.sh", memoryMb: 32 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(Object.keys(v.errors).sort()).toEqual(["command", "memoryMb", "name"]);
    expect(v.errors.command).toMatch(/^The command must begin with node, npm or npx/);
  });
});

describe("scriptSuggestions", () => {
  it("offers package.json's scripts as npm run, without the ones for a laptop", () => {
    expect(scriptSuggestions({ start: "node server.js", dev: "nodemon", "dev:api": "x", worker: "node worker.js", "migrate:mongo": "node m.js", test: "jest", lint: "eslint .", "bad name": "x" })).toEqual([
      "npm run start",
      "npm run worker",
      "npm run migrate:mongo",
    ]);
    expect(scriptSuggestions(undefined)).toEqual([]);
  });
});
