// Folds /responses SSE frames into a Turn.

import type {
  AssembledToolCall,
  DoneData,
  StreamError,
  Turn,
  TurnObserver,
  TwiggWarning,
} from "../core/client.js";
import type { SseFrame } from "./sse.js";
import type { ResponseEvent } from "./types.js";

type EventData<E extends ResponseEvent["event"]> = Extract<ResponseEvent, { event: E }>["data"];

/** Mutable state for one turn; feed frames in order with `push`, read `turn` at the end. */
export class TurnAssembler {
  readonly turn: Turn = {
    runId: "",
    chatId: "",
    closedToolCalls: [],
    text: "",
    reasoning: "",
    refusal: "",
    toolCalls: [],
    warnings: [],
  };
  private tool: AssembledToolCall | undefined;

  constructor(private readonly observer: TurnObserver = {}) {}

  /** True once a terminal `done` or `error` event arrived. */
  get finished(): boolean {
    return this.turn.done !== undefined || this.turn.error !== undefined;
  }

  push(frame: SseFrame): void {
    let data: unknown;
    try {
      data = JSON.parse(frame.data);
    } catch {
      return; // Not a Twigg event; ignore.
    }
    const ev = { event: frame.event, data } as ResponseEvent;
    switch (ev.event) {
      case "run":
        this.turn.runId = ev.data.run_id;
        this.turn.chatId = ev.data.chat_id;
        this.turn.closedToolCalls = ev.data.closed_tool_calls ?? [];
        this.observer.onRun?.(ev.data.run_id);
        break;
      case "config_warnings":
        this.addWarnings("config", ev.data.warnings);
        break;
      case "translation_warnings":
        this.addWarnings("translation", ev.data.warnings);
        break;
      case "compacting":
        this.observer.onCompacting?.();
        break;
      case "block_start":
        this.closeTool();
        if (ev.data.kind === "tool_call") {
          this.tool = {
            id: ev.data.tool_use_id,
            name: ev.data.tool_name,
            rawArguments: "",
            input: undefined,
          };
        }
        break;
      case "delta":
        switch (ev.data.kind) {
          case "text":
            this.turn.text += ev.data.text;
            break;
          case "reasoning":
            this.turn.reasoning += ev.data.text;
            break;
          case "refusal":
            this.turn.refusal += ev.data.text;
            break;
          case "tool_input":
            if (this.tool) this.tool.rawArguments += ev.data.text;
            break;
        }
        break;
      case "block_stop":
        this.closeTool();
        break;
      case "done":
        this.closeTool();
        this.turn.done = toDone(ev.data);
        break;
      case "error":
        this.closeTool();
        this.turn.error = {
          code: ev.data.code,
          message: ev.data.message,
          hint: ev.data.hint,
          details: ev.data.details,
        };
        break;
    }
  }

  /** Mark the turn failed because the stream ended without `done`/`error`. */
  fail(error: StreamError): void {
    this.closeTool();
    if (!this.finished) this.turn.error = error;
  }

  private closeTool(): void {
    const call = this.tool;
    if (!call) return;
    this.tool = undefined;
    try {
      // Some providers send no argument text for a no-argument call.
      call.input = JSON.parse(call.rawArguments === "" ? "{}" : call.rawArguments);
    } catch {
      call.input = undefined;
    }
    this.turn.toolCalls.push(call);
    this.observer.onToolCall?.(call);
  }

  private addWarnings(
    source: TwiggWarning["source"],
    list: { code: string; message: string }[] | undefined,
  ): void {
    for (const w of list ?? []) {
      const warning: TwiggWarning = { source, code: w.code, message: w.message };
      this.turn.warnings.push(warning);
      this.observer.onWarning?.(warning);
    }
  }
}

function toDone(d: EventData<"done">): DoneData {
  return {
    stopReason: d.stop_reason,
    pendingToolCalls: (d.pending_tool_calls ?? []).map((c) => ({
      id: c.tool_use_id,
      name: c.tool_name,
    })),
    usage: {
      input: d.usage?.input_tokens ?? 0,
      output: d.usage?.output_tokens ?? 0,
      cacheRead: d.usage?.cache_read_tokens ?? 0,
      cacheWrite: d.usage?.cache_write_tokens ?? 0,
      reasoning: d.usage?.reasoning_tokens ?? 0,
    },
    cost: d.cost == null ? null : Number(d.cost),
    modelServed: d.model_served ?? null,
    compaction: d.compaction
      ? {
          blocksGenerated: d.compaction.blocks_generated,
          blocksReused: d.compaction.blocks_reused,
        }
      : null,
  };
}
