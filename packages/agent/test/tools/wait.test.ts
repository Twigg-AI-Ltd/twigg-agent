import { describe, expect, it } from "vitest";
import { WAIT_MARGIN_MS, waitTool } from "../../src/tools/wait.js";
import { makeCtx } from "./helpers.js";

describe("wait", () => {
  it("waits the requested time", async () => {
    const started = Date.now();
    const out = await waitTool.run({ minutes: 0.002, reason: "replies" }, makeCtx("/tmp"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(out).toEqual({
      isError: false,
      text: expect.stringMatching(/^Waited \d+ms\. Continue\.$/),
    });
  });

  it("stops short of the run's time limit and says to wrap up", async () => {
    const ctx = { ...makeCtx("/tmp"), runRemainingMs: WAIT_MARGIN_MS + 50 };
    const started = Date.now();
    const out = await waitTool.run({ minutes: 30 }, ctx);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.text).toMatch(/instead of 30m00s: the run's time limit is close\. Wrap up now/);
  });

  it("ends early when the run is interrupted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const out = await waitTool.run({ minutes: 10 }, makeCtx("/tmp", { signal: controller.signal }));
    expect(out).toMatchObject({ isError: true, text: expect.stringMatching(/interrupted/) });
  });

  it("rejects nonsense durations", async () => {
    expect((await waitTool.run({ minutes: 0 }, makeCtx("/tmp"))).isError).toBe(true);
    expect((await waitTool.run({ minutes: -5 }, makeCtx("/tmp"))).isError).toBe(true);
  });
});
