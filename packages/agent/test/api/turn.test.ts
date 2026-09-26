import { describe, expect, it, vi } from "vitest";
import { parseSse, type SseFrame } from "../../src/api/sse.js";
import { TurnAssembler } from "../../src/api/turn.js";
import type { Turn, TurnObserver } from "../../src/core/client.js";
import { chunked, fixture, randomSizes } from "./helpers.js";

async function turnOf(name: string, observer?: TurnObserver): Promise<Turn> {
  const a = new TurnAssembler(observer);
  for await (const f of parseSse(chunked(fixture(`sse/${name}.sse`), randomSizes(7)))) a.push(f);
  return a.turn;
}

function turnFrom(frames: [string, unknown][]): Turn {
  const a = new TurnAssembler();
  for (const [event, data] of frames) a.push({ event, data: JSON.stringify(data) } as SseFrame);
  return a.turn;
}

describe("TurnAssembler", () => {
  it("text-only", async () => {
    const onRun = vi.fn();
    const t = await turnOf("text-only", { onRun });
    expect(onRun).toHaveBeenCalledWith("01a0d4e4-5799-7611-8ff8-9e080cf74d18");
    expect(t.chatId).toBe("01a0d4e4-56f8-7c93-bb06-32cea8135c70");
    expect(t.text).toBe("Hello there, how are you?");
    expect(t.toolCalls).toEqual([]);
    expect(t.warnings).toEqual([]);
    expect(t.error).toBeUndefined();
    expect(t.done).toEqual({
      stopReason: "end_turn",
      pendingToolCalls: [],
      usage: { input: 12, output: 68, cacheRead: 0, cacheWrite: 0, reasoning: 55 },
      cost: 0.00003696,
      modelServed: "gpt-6-luna",
      compaction: null,
    });
  });

  it("tool-call-args joins deltas and parses at block_stop", async () => {
    const onToolCall = vi.fn();
    const t = await turnOf("tool-call-args", { onToolCall });
    const call = {
      id: "call_24q560NSA4Nt1eeDAW45bMw4",
      name: "write_file",
      rawArguments: '{"content":"hi there","path":"notes/a.txt"}',
      input: { content: "hi there", path: "notes/a.txt" },
    };
    expect(t.toolCalls).toEqual([call]);
    expect(onToolCall).toHaveBeenCalledWith(call);
    expect(t.done?.stopReason).toBe("tool_use");
    expect(t.done?.pendingToolCalls).toEqual([{ id: call.id, name: "write_file" }]);
    expect(t.done?.cost).toBe(0.00001974);
  });

  it("text-and-tool-gemini handles interleaved text and tool blocks", async () => {
    const t = await turnOf("text-and-tool-gemini");
    expect(t.text).toBe("I will write the letter 'x' to the file named 'b.txt'.\n\n");
    expect(t.toolCalls).toHaveLength(1);
    expect(t.toolCalls[0]).toMatchObject({
      id: "call_2805269",
      name: "write_file",
      input: { content: "x", path: "b.txt" },
    });
    expect(t.done?.modelServed).toBe("gemini-3.1-flash-lite");
    expect(t.done?.cost).toBe(0.0003066);
    expect(t.done?.usage.reasoning).toBe(144);
  });

  it("reasoning-claude", async () => {
    const t = await turnOf("reasoning-claude");
    expect(t.text).toBe("42");
    expect(t.toolCalls[0]).toMatchObject({
      id: "toolu_01P7n74ykc7MxDkiphRTcQon",
      name: "write_file",
      input: { path: "c.txt", content: "42" },
    });
    expect(t.done?.cost).toBe(0.0017388);
    expect(t.done?.modelServed).toBe("claude-sonnet-5");
  });

  it("handles multiple tool calls, invalid JSON, reasoning, warnings, null cost and compaction", () => {
    const onWarning = vi.fn();
    const onCompacting = vi.fn();
    const a = new TurnAssembler({ onWarning, onCompacting });
    const frames: [string, unknown][] = [
      ["run", { run_id: "r", chat_id: "c", closed_tool_calls: ["old"] }],
      ["config_warnings", { warnings: [{ code: "history_dropped", message: "dropped 3" }] }],
      ["compacting", { blocks: 2, in_progress_elsewhere: 0 }],
      ["translation_warnings", { warnings: [{ code: "tool_field_dropped", message: "f" }] }],
      ["block_start", { kind: "reasoning" }],
      ["delta", { kind: "reasoning", text: "think" }],
      ["block_stop", {}],
      ["block_start", { kind: "tool_call", tool_name: "a", tool_use_id: "1" }],
      ["delta", { kind: "tool_input", text: '{"x":' }],
      ["block_stop", {}],
      ["block_start", { kind: "text" }],
      ["delta", { kind: "text", text: "A" }],
      ["block_stop", {}],
      ["block_start", { kind: "tool_call", tool_name: "b", tool_use_id: "2" }],
      ["delta", { kind: "tool_input", text: '{"y":2}' }],
      ["block_stop", {}],
      ["block_start", { kind: "text" }],
      ["delta", { kind: "text", text: "B" }],
      ["block_stop", {}],
      [
        "done",
        {
          stop_reason: "tool_use",
          pending_tool_calls: [],
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
            reasoning_tokens: 5,
          },
          cost: null,
          cost_currency: "USD",
          model_served: null,
          compaction: { blocks_generated: 1, blocks_reused: 2, in_progress_elsewhere: 0 },
        },
      ],
    ];
    for (const [event, data] of frames) a.push({ event, data: JSON.stringify(data) });
    const t = a.turn;
    expect(t.closedToolCalls).toEqual(["old"]);
    expect(t.text).toBe("AB");
    expect(t.reasoning).toBe("think");
    expect(t.toolCalls).toEqual([
      { id: "1", name: "a", rawArguments: '{"x":', input: undefined },
      { id: "2", name: "b", rawArguments: '{"y":2}', input: { y: 2 } },
    ]);
    expect(t.warnings).toEqual([
      { source: "config", code: "history_dropped", message: "dropped 3" },
      { source: "translation", code: "tool_field_dropped", message: "f" },
    ]);
    expect(onWarning).toHaveBeenCalledTimes(2);
    expect(onCompacting).toHaveBeenCalledOnce();
    expect(t.done?.cost).toBeNull();
    expect(t.done?.usage).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      reasoning: 5,
    });
    expect(t.done?.compaction).toEqual({ blocksGenerated: 1, blocksReused: 2 });
  });

  it("maps a terminal error event to Turn.error", () => {
    const t = turnFrom([
      ["run", { run_id: "r", chat_id: "c", closed_tool_calls: [] }],
      ["block_start", { kind: "text" }],
      ["delta", { kind: "text", text: "partial" }],
      ["error", { code: "provider_error", message: "upstream failed", hint: null }],
    ]);
    expect(t.done).toBeUndefined();
    expect(t.error).toEqual({
      code: "provider_error",
      message: "upstream failed",
      hint: null,
      details: undefined,
    });
    expect(t.text).toBe("partial");
  });
});
