import { describe, expect, it } from "vitest";
import { Budget } from "../../src/agent/budget.js";
import { runAgent } from "../../src/agent/loop.js";
import { createSubagentTool } from "../../src/agent/subagent.js";
import type { CreateResponseRequest } from "../../src/api/types.js";
import {
  type AssembledToolCall,
  type Turn,
  type TwiggClient,
  TwiggError,
} from "../../src/core/client.js";
import type { LogEvent, RunConfig, SubagentSummary, Tool } from "../../src/core/types.js";

type Step = (req: CreateResponseRequest) => Partial<Turn> | Error;

function call(name: string, input: unknown, id = `id-${name}-${Math.random()}`): AssembledToolCall {
  return { id, name, input, rawArguments: JSON.stringify(input) };
}

function finish(status = "success", summary = "done"): Partial<Turn> {
  return { toolCalls: [call("finish", { status, summary })] };
}

/** Fake client: each chat consumes steps from a script keyed by chat title order. */
function fakeClient(scripts: Step[][]) {
  const requests: { chatId: string; req: CreateResponseRequest }[] = [];
  let chats = 0;
  const cursors = new Map<string, { steps: Step[]; i: number }>();
  const client: TwiggClient = {
    async createChat() {
      const id = `chat-${chats}`;
      cursors.set(id, { steps: scripts[chats] ?? [], i: 0 });
      chats++;
      return {
        id,
        created_at: "",
        namespace: null,
        title: null,
        description: null,
        user_metadata: {},
      };
    },
    async respond(chatId, req) {
      requests.push({ chatId, req });
      const c = cursors.get(chatId);
      const step = c?.steps[c.i++];
      if (!step) throw new Error(`no scripted step for ${chatId}`);
      const r = step(req);
      if (r instanceof Error) throw r;
      return {
        runId: `run-${requests.length}`,
        chatId,
        closedToolCalls: [],
        text: "",
        reasoning: "",
        refusal: "",
        toolCalls: [],
        warnings: [],
        done: {
          stopReason: "end_turn",
          pendingToolCalls: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          cost: 0.01,
          modelServed: req.model,
          compaction: null,
        },
        ...r,
      };
    },
    getRun: async () => {
      throw new Error("unused");
    },
    getHistory: async () => {
      throw new Error("unused");
    },
    listModelNames: async () => [],
  };
  return { client, requests };
}

function config(over: Partial<RunConfig> = {}): RunConfig {
  return {
    instructionsPath: "task.md",
    task: "do it",
    model: "m1",
    namespace: "test",
    subagentModels: ["m1"],
    maxConcurrentSubagents: 2,
    permissions: {
      fs: { root: "/", read: true, write: true, delete: true },
      network: true,
      bash: false,
      disabledTools: [],
      protectedPaths: [],
    },
    limits: { maxTurns: 10, timeoutMs: 60_000, toolTimeoutMs: 5_000, warnAt: 0.8 },
    logFormat: "human",
    progressEvery: 0,
    cwd: "/tmp",
    tools: [],
    ...over,
  };
}

function setup(scripts: Step[][], over: Partial<RunConfig> = {}) {
  const events: LogEvent[] = [];
  const logger = { log: (e: LogEvent) => void events.push(e), close: async () => {} };
  const cfg = config(over);
  const { client, requests } = fakeClient(scripts);
  const budget = new Budget(cfg.limits, logger, cfg.progressEvery);
  const deps = { client, config: cfg, logger, budget, signal: new AbortController().signal };
  return { deps, requests, events, budget };
}

const echo: Tool = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object", properties: { v: { type: "string" } } },
  run: async (input) => ({ text: `echo:${(input as { v: string }).v}`, isError: false }),
};

const spec = (tools: Tool[] = [echo], extra = {}) => ({
  agentId: "main",
  namespace: "test/twigg-agent/main",
  title: "t",
  prompt: "go",
  model: "m1",
  tools,
  ...extra,
});

describe("runAgent", () => {
  it("returns the finish result", async () => {
    const { deps } = setup([[() => finish("success", "all good")]]);
    const out = await runAgent(spec(), deps);
    expect(out).toMatchObject({ status: "success", summary: "all good", chatId: "chat-0" });
  });

  it("executes tools and sends all results back in one submission", async () => {
    const { deps, requests } = setup([
      [
        () => ({ toolCalls: [call("echo", { v: "a" }, "c1"), call("echo", { v: "b" }, "c2")] }),
        () => finish(),
      ],
    ]);
    await runAgent(spec(), deps);
    expect(requests[1]?.req.input).toMatchObject([
      { type: "tool_result", tool_use_id: "c1", text: "echo:a", is_error: false },
      { type: "tool_result", tool_use_id: "c2", text: "echo:b" },
    ]);
  });

  it("runs other tool calls in the same turn before honouring finish", async () => {
    let ran = false;
    const t: Tool = {
      ...echo,
      run: async () => {
        ran = true;
        return { text: "ok", isError: false };
      },
    };
    const { deps } = setup([
      [() => ({ toolCalls: [call("echo", { v: "x" }), ...(finish().toolCalls ?? [])] })],
    ]);
    const out = await runAgent(spec([t]), deps);
    expect(ran).toBe(true);
    expect(out.status).toBe("success");
  });

  it("reports unknown tools and invalid JSON as tool errors", async () => {
    const { deps, requests } = setup([
      [
        () => ({
          toolCalls: [
            call("nope", {}, "u1"),
            { id: "u2", name: "echo", input: undefined, rawArguments: "{bad" },
          ],
        }),
        () => finish(),
      ],
    ]);
    await runAgent(spec(), deps);
    expect(requests[1]?.req.input).toMatchObject([
      { tool_use_id: "u1", is_error: true },
      { tool_use_id: "u2", is_error: true },
    ]);
  });

  it("nudges once when the model stops without finish, then fails", async () => {
    const { deps, requests } = setup([
      [() => ({ text: "I think I'm done" }), () => ({ text: "yes" })],
    ]);
    const out = await runAgent(spec(), deps);
    expect(requests[1]?.req.input[0]).toMatchObject({ type: "prompt" });
    expect(out.status).toBe("failed");
  });

  it("rejects an invalid finish and lets the model correct it", async () => {
    const { deps } = setup([
      [() => ({ toolCalls: [call("finish", { status: "great" })] }), () => finish()],
    ]);
    expect((await runAgent(spec(), deps)).status).toBe("success");
  });

  it("injects a wrap-up warning next to tool results, once, then stops at the limit", async () => {
    const loopStep: Step = () => ({ toolCalls: [call("echo", { v: "x" })] });
    const { deps, requests, events } = setup([Array(10).fill(loopStep)], {
      limits: { maxTurns: 5, timeoutMs: 60_000, toolTimeoutMs: 5_000, warnAt: 0.8 },
    });
    const out = await runAgent(spec(), deps);
    expect(out).toMatchObject({ status: "limit_reached", limitHit: "turns" });
    expect(requests).toHaveLength(5);
    const warned = requests.filter((r) =>
      r.req.input.some((p) => p.type === "prompt" && p.text?.includes("Limit warning")),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.req.input[0]).toMatchObject({ type: "tool_result" });
    expect(events.filter((e) => e.type === "limit_warning")).toHaveLength(1);
  });

  it("switches to the fallback model on a provider failure and resends the same input", async () => {
    const { deps, requests, events } = setup([
      [() => new TwiggError(503, "unavailable", "down"), () => finish()],
    ]);
    const out = await runAgent(spec([echo], { fallbackModel: "m2" }), deps);
    expect(out).toMatchObject({ status: "success", model: "m2" });
    expect(requests.map((r) => r.req.model)).toEqual(["m1", "m2"]);
    expect(requests[1]?.req.input).toEqual(requests[0]?.req.input);
    expect(events.some((e) => e.type === "model_fallback")).toBe(true);
  });

  it("retries a failed run with retry_of on the fallback model", async () => {
    const { deps, requests } = setup([
      [
        () => ({ error: { code: "external_service_error", message: "boom" }, done: undefined }),
        () => finish(),
      ],
    ]);
    await runAgent(spec([echo], { fallbackModel: "m2" }), deps);
    expect(requests[1]?.req).toMatchObject({ model: "m2", input: [], retry_of: "run-1" });
  });

  it("returns an error outcome for non-provider failures", async () => {
    const { deps } = setup([[() => new TwiggError(422, "validation_error", "bad")]]);
    expect((await runAgent(spec(), deps)).status).toBe("error");
  });

  it("maps an abort for time to limit_reached", async () => {
    const { deps } = setup([[() => ({ toolCalls: [call("echo", { v: "x" })] })]]);
    const ac = new AbortController();
    ac.abort("time");
    const out = await runAgent(spec(), { ...deps, signal: ac.signal });
    expect(out).toMatchObject({ status: "limit_reached", limitHit: "time" });
  });
});

describe("subagent tool", () => {
  it("runs subagents concurrently up to the cap and returns their finish results", async () => {
    let active = 0;
    let peak = 0;
    const slow: Tool = {
      ...echo,
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { text: "ok", isError: false };
      },
    };
    const subScript: Step[] = [
      () => ({ toolCalls: [call("echo", { v: "x" })] }),
      () => finish("success", "sub done"),
    ];
    const { deps, requests } = setup([
      [
        () => ({
          toolCalls: [
            call("subagent", { task: "a" }, "s1"),
            call("subagent", { task: "b" }, "s2"),
            call("subagent", { task: "c" }, "s3"),
          ],
        }),
        () => finish(),
      ],
      subScript,
      subScript,
      subScript,
    ]);
    const summaries: SubagentSummary[] = [];
    const tool = createSubagentTool({
      deps,
      namespace: "test/twigg-agent/subagent",
      buildTools: () => [slow],
      bashDisabledReason: () => undefined,
      summaries,
    });
    const out = await runAgent(spec([tool]), deps);
    expect(out.status).toBe("success");
    expect(peak).toBe(2);
    expect(summaries).toHaveLength(3);
    const results = requests.find(
      (r) => r.chatId === "chat-0" && r.req.input[0]?.type === "tool_result",
    );
    expect(results?.req.input).toHaveLength(3);
    expect(results?.req.input[0]).toMatchObject({ tool_use_id: "s1", is_error: false });
    expect(
      JSON.parse((results?.req.input[0] as { text: string } | undefined)?.text ?? "null"),
    ).toMatchObject({
      status: "success",
      summary: "sub done",
    });
  });

  it("rejects models outside the allow-list", async () => {
    const { deps } = setup([]);
    const tool = createSubagentTool({
      deps,
      namespace: "ns",
      buildTools: () => [],
      bashDisabledReason: () => undefined,
      summaries: [],
    });
    const ctx = {} as Parameters<Tool["run"]>[1];
    expect((await tool.run({ task: "x", model: "evil" }, ctx)).isError).toBe(true);
  });
});

describe("Budget progress", () => {
  it("logs one progress line per step even when turns are recorded out of order", () => {
    const events: LogEvent[] = [];
    const b = new Budget(
      config().limits,
      { log: (e) => void events.push(e), close: async () => {} },
      5,
    );
    for (let i = 0; i < 12; i++) b.startTurn();
    for (let i = 0; i < 12; i++) b.record(`r${i}`, undefined);
    const done = {
      stopReason: "end_turn" as const,
      pendingToolCalls: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: 0,
      modelServed: null,
      compaction: null,
    };
    b.record("a", done);
    b.record("b", done);
    expect(events.filter((e) => e.type === "progress")).toHaveLength(1);
  });
});
