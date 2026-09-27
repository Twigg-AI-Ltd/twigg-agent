import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES } from "../src/core/types.js";
import { main } from "../src/main.js";

let dir: string;
let stderr: string;
let stdout: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "main-"));
  stderr = "";
  stdout = "";
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.stubEnv("TWIGG_API_KEY", "");
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += String(s);
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += String(s);
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("main without an API key", () => {
  it("reports the missing key before anything else, with where to get one", async () => {
    await writeFile(join(dir, "task.md"), "no model set\n");
    for (const argv of [["task.md"], [], ["models"], ["--no-such-flag"]]) {
      stderr = "";
      expect(await main(argv)).toBe(EXIT_CODES.error);
      expect(stderr).toMatch(/^twigg-agent: no Twigg API key found/);
      expect(stderr).toContain("https://twigg.ai");
      expect(stderr).not.toMatch(/model: required|instructions/);
    }
  });

  it("still shows help, the version and the tools list", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(stdout).toContain("twigg-agent models");
    expect(await main(["--version"])).toBe(0);
    expect(await main(["tools"])).toBe(0);
    expect(stderr).toBe("");
  });

  it("reads the key from .env, then reports other problems as before", async () => {
    await writeFile(join(dir, ".env"), "TWIGG_API_KEY=tw_test\n");
    await writeFile(join(dir, "task.md"), "no model set\n");
    expect(await main(["task.md"])).toBe(EXIT_CODES.error);
    expect(stderr).toMatch(/model: required .*twigg-agent models/);
  });
});
