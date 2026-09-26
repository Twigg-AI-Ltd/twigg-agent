import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/core/types.js";
import { exitCodeFor, writeResult } from "../src/result.js";

const result: RunResult = {
  status: "needs_clarification",
  summary: "Need input",
  reason: "Ambiguous target",
  clarifications: ["Which branch?"],
  model: "m",
  runIds: ["r1"],
  turns: 3,
  tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  costUsd: 0.01,
  durationMs: 1000,
  subagents: [],
};

describe("writeResult", () => {
  it("writes pretty JSON and creates parent dirs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "twigg-result-"));
    try {
      const file = path.join(dir, "a/b/result.json");
      await writeResult(file, result);
      const text = await readFile(file, "utf8");
      expect(JSON.parse(text)).toEqual(result);
      expect(text).toContain('\n  "status": "needs_clarification"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exitCodeFor", () => {
  it.each([
    ["success", 0],
    ["failed", 1],
    ["needs_clarification", 2],
    ["limit_reached", 3],
    ["error", 4],
    ["interrupted", 130],
  ] as const)("%s → %d", (status, code) => {
    expect(exitCodeFor(status)).toBe(code);
  });
});
