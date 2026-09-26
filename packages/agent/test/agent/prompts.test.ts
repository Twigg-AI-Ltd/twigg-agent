import { describe, expect, it } from "vitest";
import { localDate } from "../../src/agent/prompts.js";

describe("run brief", () => {
  it("states today's local date and weekday", () => {
    expect(localDate(new Date(2026, 8, 25, 23, 30))).toBe("2026-09-25 (Friday)");
  });
});
