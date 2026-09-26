import type { CreateResponseRequest, SubmittedPart } from "../api/types.js";
import { type AssembledToolCall, type Turn, type TwiggClient, TwiggError } from "../core/client.js";
import type {
  FinishStatus,
  LimitName,
  Logger,
  RunConfig,
  Tool,
  ToolContext,
  ToolOutput,
} from "../core/types.js";
import type { Budget } from "./budget.js";

export const FINISH_TOOL_NAME = "finish";

export const FINISH_DEFINITION = {
  name: FINISH_TOOL_NAME,
  description:
    "End the run. Call exactly once, when the task is complete, has failed, or cannot proceed without clarification.",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["success", "failed", "needs_clarification"] },
      summary: { type: "string", description: "Short, factual record of what was done." },
      reason: {
        type: "string",
        description: "Why the run failed or needs clarification. Empty on success.",
      },
      clarifications: {
        type: "array",
        items: { type: "string" },
        description: "With needs_clarification: the questions that must be answered.",
      },
    },
    required: ["status", "summary"],
  },
} as const;

export interface AgentOutcome {
  status: FinishStatus | "limit_reached" | "error" | "interrupted";
  summary: string;
  reason: string;
  clarifications: string[];
  limitHit?: LimitName;
  chatId?: string;
  model: string;
}

export interface AgentSpec {
  agentId: string;
  namespace: string;
  title: string;
  prompt: string;
  model: string;
  fallbackModel?: string;
  tools: Tool[];
}

export interface LoopDeps {
  client: TwiggClient;
  config: RunConfig;
  logger: Logger;
  budget: Budget;
  /** Aborted on run timeout or SIGINT; `reason` is "time" or "interrupted". */
  signal: AbortSignal;
}

const MAX_FINISH_NUDGES = 1;
/** Twigg rejects chat titles longer than this. */
const MAX_TITLE = 50;

export async function runAgent(spec: AgentSpec, deps: LoopDeps): Promise<AgentOutcome> {
  const { client, config, logger, budget, signal } = deps;
  const { agentId } = spec;
  let model = spec.model;
  const toolsByName = new Map(spec.tools.map((t) => [t.name, t]));
  const toolDefs = [
    ...spec.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    })),
    FINISH_DEFINITION,
  ];
  const outcome = (o: Omit<AgentOutcome, "model" | "chatId">): AgentOutcome => ({
    ...o,
    model,
    chatId,
  });

  let chatId: string | undefined;
  try {
    chatId = (
      await client.createChat({
        namespace: spec.namespace,
        title: spec.title.slice(0, MAX_TITLE),
        user_metadata: { agent: agentId, model },
      })
    ).id;
  } catch (e) {
    return outcome(errorOutcome(`could not create chat: ${message(e)}`));
  }

  let input: SubmittedPart[] = [{ type: "prompt", text: spec.prompt }];
  let retryOf: string | undefined;
  let nudges = 0;

  for (;;) {
    if (signal.aborted) return outcome(abortOutcome(signal));
    const hit = budget.exceeded();
    if (hit) return outcome(limitOutcome(hit));

    budget.startTurn();
    logger.log({ type: "turn_start", agentId, turn: budget.turns, model });
    const req: CreateResponseRequest = {
      model,
      input: retryOf ? [] : input,
      tools: toolDefs,
      idempotency_key: crypto.randomUUID(),
      ...(retryOf ? { retry_of: retryOf } : {}),
      ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
    };

    let turn: Turn;
    try {
      turn = await client.respond(chatId, req, {
        signal,
        observer: {
          onWarning: (w) => logger.log({ type: "twigg_warning", agentId, ...w }),
          onCompacting: () => logger.log({ type: "compacting", agentId }),
        },
      });
    } catch (e) {
      if (signal.aborted) return outcome(abortOutcome(signal));
      if (e instanceof TwiggError && e.isProviderFailure && canFallback()) {
        switchToFallback(e.message);
        continue; // nothing was appended; resend the same input
      }
      return outcome(errorOutcome(`Twigg request failed: ${message(e)}`));
    }
    budget.record(turn.runId, turn.done);
    retryOf = undefined;

    if (turn.text.trim()) logger.log({ type: "assistant_text", agentId, text: turn.text });
    if (turn.refusal.trim()) logger.log({ type: "assistant_text", agentId, text: turn.refusal });

    if (turn.error) {
      // The run failed after the stream opened; its input is kept, so retry it via retry_of.
      if (turn.error.code === "external_service_error" && canFallback()) {
        switchToFallback(turn.error.message);
        retryOf = turn.runId;
        continue;
      }
      return outcome(errorOutcome(`model run failed: ${turn.error.code}: ${turn.error.message}`));
    }

    const finish = turn.toolCalls.find((c) => c.name === FINISH_TOOL_NAME);
    const others = turn.toolCalls.filter((c) => c.name !== FINISH_TOOL_NAME);
    const results = await executeAll(others);
    if (signal.aborted) return outcome(abortOutcome(signal));

    if (finish) {
      const parsed = parseFinish(finish);
      if (parsed.ok) {
        logger.log({ type: "tool_call", agentId, tool: FINISH_TOOL_NAME, input: finish.input });
        return outcome(parsed.value);
      }
      results.push(toolResult(finish, { text: parsed.error, isError: true }));
    }

    input = results;
    if (results.length === 0) {
      // The model stopped without calling finish.
      if (turn.done?.stopReason === "refusal") {
        return outcome({
          status: "failed",
          summary: "The model refused the task.",
          reason: turn.refusal || turn.text,
          clarifications: [],
        });
      }
      if (nudges >= MAX_FINISH_NUDGES) {
        return outcome({
          status: "failed",
          summary: "The agent stopped without calling finish.",
          reason: turn.text.slice(0, 2000),
          clarifications: [],
        });
      }
      nudges++;
      input = [
        {
          type: "prompt",
          text: "[twigg-agent harness] Nobody reads plain replies. If the task is not complete, continue with tools. Otherwise call `finish` now.",
        },
      ];
    }

    const warning = budget.takeWarnings(agentId);
    if (warning) input.push({ type: "prompt", text: warning });
  }

  function canFallback(): boolean {
    return spec.fallbackModel !== undefined && model !== spec.fallbackModel;
  }

  function switchToFallback(reason: string): void {
    const to = spec.fallbackModel as string;
    logger.log({ type: "model_fallback", agentId, from: model, to, reason });
    model = to;
  }

  async function executeAll(calls: AssembledToolCall[]): Promise<SubmittedPart[]> {
    // Subagents run concurrently (the subagent tool queues internally); everything else runs in
    // call order so dependent file operations see each other's effects.
    const parallel = calls.map((c) => (c.name === SUBAGENT_TOOL_NAME ? execute(c) : undefined));
    const out: SubmittedPart[] = [];
    for (const [i, call] of calls.entries()) {
      out.push(await (parallel[i] ?? execute(call)));
    }
    return out;
  }

  async function execute(call: AssembledToolCall): Promise<SubmittedPart> {
    logger.log({
      type: "tool_call",
      agentId,
      tool: call.name,
      input: call.input ?? call.rawArguments,
    });
    const started = Date.now();
    const tool = toolsByName.get(call.name);
    let output: ToolOutput;
    if (!tool) {
      output = { text: `Unknown tool "${call.name}".`, isError: true };
    } else if (call.input === undefined) {
      output = {
        text: `Tool arguments were not valid JSON: ${call.rawArguments.slice(0, 500)}`,
        isError: true,
      };
    } else {
      const ctx: ToolContext = {
        permissions: config.permissions,
        cwd: config.cwd,
        signal,
        timeoutMs: Math.min(config.limits.toolTimeoutMs, budget.remainingMs),
        runRemainingMs: budget.remainingMs,
        logger,
        agentId,
      };
      try {
        output = await tool.run(call.input, ctx);
      } catch (e) {
        output = { text: `Tool crashed: ${message(e)}`, isError: true };
      }
    }
    logger.log({
      type: "tool_result",
      agentId,
      tool: call.name,
      isError: output.isError,
      blocked: output.blocked ?? false,
      preview: output.text.slice(0, 500),
      durationMs: Date.now() - started,
    });
    return toolResult(call, output);
  }
}

export const SUBAGENT_TOOL_NAME = "subagent";

function toolResult(call: AssembledToolCall, output: ToolOutput): SubmittedPart {
  return {
    type: "tool_result",
    tool_use_id: call.id,
    tool_name: call.name,
    text: output.text,
    is_error: output.isError,
    trust: output.trust ?? (call.name === "web_fetch" ? "untrusted" : "customer_data"),
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseFinish(call: AssembledToolCall): Parsed<Omit<AgentOutcome, "model" | "chatId">> {
  const i = call.input as Record<string, unknown> | undefined;
  const status = i?.status;
  if (status !== "success" && status !== "failed" && status !== "needs_clarification") {
    return {
      ok: false,
      error: 'finish: "status" must be one of success, failed, needs_clarification.',
    };
  }
  if (typeof i?.summary !== "string" || !i.summary.trim()) {
    return { ok: false, error: 'finish: "summary" is required.' };
  }
  const clarifications = Array.isArray(i.clarifications)
    ? i.clarifications.filter((c): c is string => typeof c === "string")
    : [];
  return {
    ok: true,
    value: {
      status,
      summary: i.summary,
      reason: typeof i.reason === "string" ? i.reason : "",
      clarifications,
    },
  };
}

function limitOutcome(limit: LimitName): Omit<AgentOutcome, "model" | "chatId"> {
  return {
    status: "limit_reached",
    summary: `Stopped: the ${limit} limit was reached before the agent finished.`,
    reason: `${limit} limit reached`,
    clarifications: [],
    limitHit: limit,
  };
}

function abortOutcome(signal: AbortSignal): Omit<AgentOutcome, "model" | "chatId"> {
  return signal.reason === "time"
    ? limitOutcome("time")
    : { status: "interrupted", summary: "Interrupted.", reason: "interrupted", clarifications: [] };
}

function errorOutcome(reason: string): Omit<AgentOutcome, "model" | "chatId"> {
  return { status: "error", summary: "The harness hit an error.", reason, clarifications: [] };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
