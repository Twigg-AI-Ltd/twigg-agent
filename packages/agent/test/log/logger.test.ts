import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogEvent, RunResult } from "../../src/core/types.js";
import { createLogger, formatDuration, useColor } from "../../src/log/index.js";

function memoryStream() {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c.toString()));
  return {
    stream,
    raw: () => chunks.join(""),
    lines: () => chunks.join("").split("\n").filter(Boolean),
  };
}

const tokens = { input: 12_300, output: 2_100, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
const result: RunResult = {
  status: "success",
  summary: "All tests pass",
  reason: "",
  clarifications: [],
  model: "m",
  runIds: [],
  turns: 12,
  tokens,
  costUsd: 0.12,
  durationMs: 184_000,
  subagents: [],
};

const events: [LogEvent, RegExp][] = [
  [
    {
      type: "run_start",
      model: "claude-sonnet-5",
      namespace: "acme/x",
      instructionsPath: "task.md",
    },
    /^▶ run {2}claude-sonnet-5 {2}ns=acme\/x {2}instructions=task\.md$/,
  ],
  [{ type: "config_notice", message: "bash disabled" }, /^ℹ config {2}bash disabled$/],
  [{ type: "turn_start", agentId: "main", turn: 3, model: "m" }, /^── turn 3 · m ──$/],
  [{ type: "assistant_text", agentId: "main", text: "Let me look." }, /^» assistant$/],
  [
    { type: "tool_call", agentId: "main", tool: "bash", input: { command: "npm test" } },
    /^→ bash {2}npm test$/,
  ],
  [
    {
      type: "tool_result",
      agentId: "main",
      tool: "bash",
      isError: false,
      blocked: false,
      preview: "PASS 3 tests",
      durationMs: 1200,
    },
    /^← bash {2}ok 1\.2s$/,
  ],
  [
    {
      type: "tool_result",
      agentId: "main",
      tool: "write",
      isError: true,
      blocked: true,
      preview: "write not permitted",
      durationMs: 1,
    },
    /^✗ write {2}BLOCKED$/,
  ],
  [
    {
      type: "todo",
      agentId: "main",
      items: [
        { text: "a", done: true },
        { text: "b", done: false },
      ],
    },
    /^☰ todo$/,
  ],
  [
    { type: "limit_warning", limit: "turns", used: 80, max: 100 },
    /^⚠ limit turns 80\/100 — agent told to wrap up$/,
  ],
  [{ type: "limit_warning", limit: "cost", used: 0.8, max: 1 }, /^⚠ limit cost \$0\.80\/\$1\.00/],
  [
    { type: "progress", turns: 10, tokens, costUsd: 0.0421, elapsedMs: 72_000 },
    /^Σ turn 10 {2}tokens in 12\.3k out 2\.1k {2}cost \$0\.0421 {2}elapsed 1m12s$/,
  ],
  [
    { type: "subagent_start", agentId: "sub-1", model: "m2", task: "Find usages" },
    /^\[sub-1\] ⇢ subagent start {2}m2$/,
  ],
  [{ type: "run_finish", result }, /^✔ finish success {2}turns 12 · \$0\.1200 · 3m04s$/],
  [{ type: "error", message: "boom" }, /^✗ error$/],
];

/** Logs one event uncoloured and returns the printed lines, blank ones included. */
function render(event: LogEvent, opts: { color?: boolean; columns?: number } = {}): string[] {
  const mem = memoryStream();
  if (opts.columns) Object.assign(mem.stream, { isTTY: true, columns: opts.columns });
  createLogger({ format: "human", stream: mem.stream, color: opts.color ?? false }).log(event);
  return mem.raw().replace(/\n$/, "").split("\n");
}

describe("human format", () => {
  it.each(events)("formats %o", (event, re) => {
    const [line] = render(event).filter(Boolean);
    expect(line).toMatch(/^\d\d:\d\d:\d\d /);
    expect(line?.slice(9)).toMatch(re);
  });

  it("keeps tool input on one truncated line", () => {
    const lines = render({
      type: "tool_call",
      agentId: "main",
      tool: "bash",
      input: { command: `echo\n${"x".repeat(500)}` },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThan(150);
    expect(lines[0]).toMatch(/…$/);
  });

  it("shows other tool input as key=value pairs", () => {
    const [line] = render({
      type: "tool_call",
      agentId: "main",
      tool: "send_email",
      input: { to: ["a@x.io", "b@x.io"], cc: [], subject: "Hi there", n: 1, o: { k: 1 } },
    });
    expect(line).toContain('→ send_email  to=a@x.io,b@x.io subject="Hi there" n=1 o={"k":1}');
  });

  it("leaves out todo calls and results, which the checklist already shows", () => {
    const mem = memoryStream();
    const logger = createLogger({ format: "human", stream: mem.stream, color: false });
    logger.log({ type: "tool_call", agentId: "main", tool: "todo", input: { items: [] } });
    logger.log({
      type: "tool_result",
      agentId: "main",
      tool: "todo",
      isError: false,
      blocked: false,
      preview: "Checklist updated",
      durationMs: 1,
    });
    expect(mem.raw()).toBe("");
  });

  it("prints multi-line text as an indented block under the head line", () => {
    const lines = render({
      type: "assistant_text",
      agentId: "main",
      text: "\n\nLet me look.\n\n\n\n- one\n- two\n\n",
    });
    expect(lines.slice(1)).toEqual([
      "         Let me look.",
      "",
      "         - one",
      "         - two",
    ]);
  });

  it("puts each todo item on its own line", () => {
    const lines = render({
      type: "todo",
      agentId: "main",
      items: [
        { text: "a", done: true },
        { text: "b", done: false },
      ],
    });
    expect(lines.slice(1).map((l) => l.trim())).toEqual(["☑ a", "☐ b"]);
  });

  it("indents subagent bodies past the agent tag", () => {
    const lines = render({
      type: "subagent_finish",
      agentId: "sub-1",
      status: "success",
      summary: "Found 2:\n- a\n- b",
    });
    expect(lines[0]).toMatch(/\[sub-1\] ⇠ subagent success$/);
    expect(lines.slice(1)).toEqual(["           Found 2:", "           - a", "           - b"]);
  });

  it("caps tool output and says how much was left out", () => {
    const lines = render({
      type: "tool_result",
      agentId: "main",
      tool: "bash",
      isError: false,
      blocked: false,
      preview: "1\n2\n3\n4\n5",
      durationMs: 5,
    });
    expect(lines.slice(1).map((l) => l.trim())).toEqual(["1", "2", "3", "… 2 more lines"]);
  });

  it("strips terminal escapes and carriage returns from tool output", () => {
    const lines = render({
      type: "tool_result",
      agentId: "main",
      tool: "bash",
      isError: true,
      blocked: false,
      preview: "\x1b[31mFAIL\x1b[0m a\r\nprogress 10%\rprogress 100%",
      durationMs: 5,
    });
    expect(lines.slice(1).map((l) => l.trim())).toEqual([
      "FAIL a",
      "progress 10%",
      "progress 100%",
    ]);
  });

  it("wraps prose to the terminal width", () => {
    const lines = render(
      { type: "assistant_text", agentId: "main", text: "word ".repeat(40) },
      { columns: 60 },
    );
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines.slice(1)) expect(l.length).toBeLessThanOrEqual(60);
  });

  it("sets turns and the final result apart with a blank line", () => {
    expect(render({ type: "turn_start", agentId: "main", turn: 1, model: "m" })[0]).toBe("");
    const finish = render({
      type: "run_finish",
      result: { ...result, status: "failed", summary: "Tried", reason: "No access" },
    });
    expect(finish[0]).toBe("");
    expect(finish.slice(2)).toEqual(["         Tried", "", "         reason: No access"]);
  });

  it("colours only when asked", () => {
    const event: LogEvent = { type: "error", message: "boom" };
    expect(render(event).join("\n")).not.toContain("\x1b[");
    expect(render(event, { color: true }).join("\n")).toContain("\x1b[31m");
  });
});

describe("useColor", () => {
  it.each([
    [true, {}, true],
    [false, {}, false],
    [true, { NO_COLOR: "1" }, false],
    [true, { TERM: "dumb" }, false],
    [false, { FORCE_COLOR: "1" }, true],
    [true, { FORCE_COLOR: "0" }, false],
  ])("tty=%s env=%o → %s", (tty, env, want) => {
    expect(useColor(tty, env)).toBe(want);
  });
});

describe("json format", () => {
  it("writes one JSON object per event with a timestamp", () => {
    const mem = memoryStream();
    const logger = createLogger({ format: "json", stream: mem.stream });
    for (const [e] of events) logger.log(e);
    const lines = mem.lines();
    expect(lines).toHaveLength(events.length);
    const first = JSON.parse(lines[0] ?? "");
    expect(first).toMatchObject(events[0]?.[0] ?? {});
    expect(new Date(first.ts).toISOString()).toBe(first.ts);
  });
});

describe("log file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "twigg-log-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends JSON events regardless of console format", async () => {
    const file = path.join(dir, "nested/run.jsonl");
    const mem = memoryStream();
    const logger = createLogger({ format: "human", stream: mem.stream, file });
    logger.log({ type: "error", message: "one" });
    logger.log({ type: "compacting", agentId: "main" });
    await logger.close();
    const logger2 = createLogger({ format: "json", stream: mem.stream, file });
    logger2.log({ type: "error", message: "two" });
    await logger2.close();
    await logger2.close();
    const lines = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["error", "compacting", "error"]);
    expect(lines[2].message).toBe("two");
  });
});

describe("formatDuration", () => {
  it.each([
    [850, "850ms"],
    [1200, "1.2s"],
    [72_000, "1m12s"],
    [3_780_000, "1h03m"],
  ])("%d → %s", (ms, s) => {
    expect(formatDuration(ms)).toBe(s);
  });
});
