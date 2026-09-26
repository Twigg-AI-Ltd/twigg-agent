// Shared contracts between modules. Change with care: api/, tools/, config/, log/ and agent/ all
// build against these.

import type { ReasoningEffort } from "../api/types.js";

// ---------------------------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------------------------

/**
 * Filesystem permissions. Built-in file tools enforce these in-process. There is no sandbox: `bash`
 * is off unless the user enables it, and then only gets the basic protected-path check (see
 * `protectedPaths`).
 */
export interface FsPermissions {
  /** Absolute path; every file tool path must resolve (after symlinks) inside it. */
  root: string;
  read: boolean;
  write: boolean;
  delete: boolean;
}

export interface Permissions {
  fs: FsPermissions;
  /** Outbound network for tools (web_fetch). */
  network: boolean;
  /** The user enabled `bash` (`--allow-bash`). Off by default: it runs unsandboxed. */
  bash: boolean;
  /** Tool names the user disabled. Disabled tools are never offered to the model. */
  disabledTools: string[];
  /**
   * Glob patterns for files no tool may read, write, edit or delete (e.g. `.env`, `.ssh/**`).
   * A pattern without "/" matches a file name anywhere; with "/" it matches a path suffix.
   */
  protectedPaths: string[];
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

export interface Limits {
  /** USD, including compaction runs. Undefined means no cap. */
  maxCostUsd?: number;
  /** Model calls (each /responses submission) across the main agent and all subagents. */
  maxTurns: number;
  /** Whole-run wall clock. */
  timeoutMs: number;
  /** Per tool call. */
  toolTimeoutMs: number;
  /** Fraction (0–1) of a limit at which the agent is warned once. */
  warnAt: number;
}

// ---------------------------------------------------------------------------------------------
// Resolved run configuration (output of config/, input to agent/)
// ---------------------------------------------------------------------------------------------

export type LogFormat = "human" | "json";

export interface RunConfig {
  /** Path of the instructions file as given. */
  instructionsPath: string;
  /** Markdown body of the instructions file, frontmatter removed. */
  task: string;
  model: string;
  fallbackModel?: string;
  /** User namespace; the harness works under `<namespace>/twigg-agent/...`. */
  namespace: string;
  /** Models the agent may pick for subagents. Empty disables the subagent tool. */
  subagentModels: string[];
  maxConcurrentSubagents: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  permissions: Permissions;
  limits: Limits;
  /** Where to write the result JSON, if anywhere. */
  outputPath?: string;
  logFormat: LogFormat;
  logFile?: string;
  /** Emit a progress line every N turns. */
  progressEvery: number;
  /** Working directory for tools (relative paths resolve against it). */
  cwd: string;
  /** Custom tools, from `tools` in settings and `--tool`. Their folders are always protected. */
  tools: ToolSource[];
}

/** Where a custom tool comes from: an npm package or a folder with a tool.json. */
export interface ToolSource {
  /** As configured: a package name or a path. */
  use: string;
  /** The folder holding tool.json; undefined when the package could not be found. */
  dir?: string;
  /** Values from settings, given to the tool as environment variables. */
  env: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

export interface ToolOutput {
  text: string;
  isError: boolean;
  /** True when a permission blocked the action; the text is the standard blocked message. */
  blocked?: boolean;
  /** Twigg trust level for the result; defaults by tool (web_fetch is untrusted). */
  trust?: "trusted" | "customer_data" | "untrusted";
}

export interface ToolContext {
  permissions: Permissions;
  cwd: string;
  /** Aborted on run timeout or SIGINT. */
  signal: AbortSignal;
  timeoutMs: number;
  /** Time left before the whole run's time limit. Only `wait` looks past `timeoutMs`. */
  runRemainingMs?: number;
  logger: Logger;
  /** Id of the agent running the tool: "main" or "sub-<n>". */
  agentId: string;
}

/** A JSON Schema describing an object (what Twigg's ToolDefinition.input_schema takes). */
export type JsonSchemaObject = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  /** Input is the parsed tool-call arguments; validate it inside run(). */
  run(input: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

// ---------------------------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------------------------

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export type LogEvent =
  | { type: "run_start"; model: string; namespace: string; instructionsPath: string }
  | { type: "config_notice"; message: string }
  | { type: "turn_start"; agentId: string; turn: number; model: string }
  | { type: "assistant_text"; agentId: string; text: string }
  | { type: "tool_call"; agentId: string; tool: string; input: unknown }
  | {
      type: "tool_result";
      agentId: string;
      tool: string;
      isError: boolean;
      blocked: boolean;
      /** Possibly truncated preview of the result. */
      preview: string;
      durationMs: number;
    }
  | { type: "todo"; agentId: string; items: { text: string; done: boolean }[] }
  | { type: "twigg_warning"; agentId: string; code: string; message: string }
  | { type: "compacting"; agentId: string }
  | { type: "limit_warning"; limit: LimitName; used: number; max: number }
  | { type: "progress"; turns: number; tokens: TokenTotals; costUsd: number; elapsedMs: number }
  | { type: "model_fallback"; agentId: string; from: string; to: string; reason: string }
  | { type: "subagent_start"; agentId: string; model: string; task: string }
  | { type: "subagent_finish"; agentId: string; status: FinishStatus; summary: string }
  | { type: "run_finish"; result: RunResult }
  | { type: "error"; agentId?: string; message: string };

export type LimitName = "cost" | "turns" | "time";

export interface Logger {
  log(event: LogEvent): void;
  /** Flush file sinks. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

export type FinishStatus = "success" | "failed" | "needs_clarification";

/** Status of the whole run as reported in the result; adds harness-level outcomes. */
export type RunStatus = FinishStatus | "limit_reached" | "error" | "interrupted";

export interface SubagentSummary {
  id: string;
  model: string;
  task: string;
  status: FinishStatus | "limit_reached" | "error";
  summary: string;
  chatId?: string;
}

export interface RunResult {
  status: RunStatus;
  summary: string;
  reason: string;
  clarifications: string[];
  limitHit?: LimitName;
  model: string;
  chatId?: string;
  runIds: string[];
  turns: number;
  tokens: TokenTotals;
  costUsd: number;
  durationMs: number;
  subagents: SubagentSummary[];
}

export const EXIT_CODES: Record<RunStatus, number> = {
  success: 0,
  failed: 1,
  needs_clarification: 2,
  limit_reached: 3,
  error: 4,
  interrupted: 130,
};
