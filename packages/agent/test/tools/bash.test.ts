import { describe, expect, it } from "vitest";
import { bashTool } from "../../src/tools/bash.js";
import { makeCtx, tempDir } from "./helpers.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("bash", () => {
  it("runs in cwd and reports the exit code", async () => {
    const dir = await tempDir();
    const out = await bashTool.run({ command: "pwd; echo err >&2" }, makeCtx(dir));
    expect(out.isError).toBe(false);
    expect(out.text).toBe(`${dir}\nerr\n[exit code: 0]`);
    const bad = await bashTool.run({ command: "exit 3" }, makeCtx(dir));
    expect(bad).toEqual({ isError: true, text: "[exit code: 3]" });
  });

  it("kills the whole process group on timeout", async () => {
    const dir = await tempDir();
    const start = Date.now();
    const out = await bashTool.run(
      { command: "sleep 30 & echo $!; wait", timeout_ms: 60_000 },
      makeCtx(dir, { timeoutMs: 300 }),
    );
    expect(Date.now() - start).toBeLessThan(5000);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("[killed: timed out after 300 ms]");
    const pid = Number(out.text.split("\n")[0]);
    await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });

  it("stops on abort signal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const out = await bashTool.run(
      { command: "sleep 30" },
      makeCtx(await tempDir(), { signal: ac.signal }),
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain("[killed: aborted]");
  });

  it("truncates long output keeping head and tail", async () => {
    const out = await bashTool.run(
      { command: "echo START; head -c 200000 /dev/zero | tr '\\0' x; echo; echo END" },
      makeCtx(await tempDir()),
    );
    expect(out.text.length).toBeLessThan(31_000);
    expect(out.text.startsWith("START")).toBe(true);
    expect(out.text).toContain("characters truncated");
    expect(out.text).toContain("END\n[exit code: 0]");
  });
});

describe("bash guards", () => {
  it("refuses commands that name a protected file", async () => {
    const dir = await tempDir();
    const out = await bashTool.run({ command: "cat .env" }, makeCtx(dir));
    expect(out.blocked).toBe(true);
  });

  it("does not pass the Twigg API key to commands", async () => {
    const dir = await tempDir();
    const prev = process.env.TWIGG_API_KEY;
    process.env.TWIGG_API_KEY = "tw_live_test";
    try {
      const out = await bashTool.run(
        { command: "printenv TWIGG_API_KEY || echo k=none" },
        makeCtx(dir),
      );
      expect(out.text).toContain("k=none");
    } finally {
      if (prev === undefined) delete process.env.TWIGG_API_KEY;
      else process.env.TWIGG_API_KEY = prev;
    }
  });
});
