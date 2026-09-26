// Contract for the Twigg client (implemented in src/api/). agent/ depends only on this.

import type {
  ChatCreated,
  CreateChatRequest,
  CreateResponseRequest,
  HistoryPageResponse,
  RunInspection,
} from "../api/types.js";

/** A tool call assembled from block_start + tool_input deltas + block_stop. */
export interface AssembledToolCall {
  id: string;
  name: string;
  /** Raw concatenated JSON argument text. */
  rawArguments: string;
  /** Parsed arguments, or undefined when rawArguments was not valid JSON. */
  input: unknown;
}

export interface TwiggWarning {
  source: "config" | "translation";
  code: string;
  message: string;
}

export interface DoneData {
  stopReason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "refusal";
  pendingToolCalls: { id: string; name: string }[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
  /** USD as a number; null when settlement is pending (look it up via getRun later). */
  cost: number | null;
  modelServed: string | null;
  compaction: { blocksGenerated: number; blocksReused: number } | null;
}

export interface StreamError {
  code: string;
  message: string;
  hint?: string | null;
  details?: unknown;
}

/** Everything one /responses call produced. Exactly one of `done` / `error` is set. */
export interface Turn {
  runId: string;
  chatId: string;
  closedToolCalls: string[];
  /** Concatenated assistant text across all text blocks, in order. */
  text: string;
  reasoning: string;
  refusal: string;
  toolCalls: AssembledToolCall[];
  warnings: TwiggWarning[];
  done?: DoneData;
  error?: StreamError;
}

/** Live callbacks while a turn streams, for logging. All optional. */
export interface TurnObserver {
  onRun?(runId: string): void;
  onWarning?(w: TwiggWarning): void;
  onCompacting?(): void;
  onToolCall?(call: AssembledToolCall): void;
}

/** Thrown for failures before the stream opens (HTTP error envelope) and for network errors. */
export class TwiggError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TwiggError";
  }

  /** 502/503 and network failures: worth a fallback model or a retry. */
  get isProviderFailure(): boolean {
    return this.status === 502 || this.status === 503 || this.status === 0;
  }
}

export interface TwiggClient {
  createChat(req: CreateChatRequest): Promise<ChatCreated>;
  /**
   * POST /chats/{id}/responses and consume the whole stream into a Turn.
   * Retries 429/503 before the stream opens (same idempotency key). Throws TwiggError for other
   * pre-stream failures. A terminal `error` event is returned as Turn.error, not thrown.
   */
  respond(
    chatId: string,
    req: CreateResponseRequest,
    opts?: { signal?: AbortSignal; observer?: TurnObserver },
  ): Promise<Turn>;
  getRun(runId: string): Promise<RunInspection>;
  getHistory(
    chatId: string,
    query?: { beforeOrdinal?: number; afterOrdinal?: number; limit?: number },
  ): Promise<HistoryPageResponse>;
  listModelNames(): Promise<string[]>;
}
