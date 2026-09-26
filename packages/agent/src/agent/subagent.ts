import type { Permissions, SubagentSummary, Tool, ToolOutput } from "../core/types.js";
import { type LoopDeps, runAgent, SUBAGENT_TOOL_NAME } from "./loop.js";
import { runBrief, SUBAGENT_RULES, taskPrompt } from "./prompts.js";

export interface SubagentToolOptions {
  deps: LoopDeps;
  namespace: string;
  /** Builds the tool set for a (possibly narrowed) permission set. */
  buildTools: (perms: Permissions) => Tool[];
  /** Why bash is unavailable under these permissions, if it is. */
  bashDisabledReason: (perms: Permissions) => string | undefined;
  /** Collects every subagent's outcome for the run result. */
  summaries: SubagentSummary[];
}

const NARROWABLE = ["read", "write", "delete", "network"] as const;

export function createSubagentTool(opts: SubagentToolOptions): Tool {
  const { deps } = opts;
  const { config } = deps;
  const models = config.subagentModels;
  const limit = pLimit(config.maxConcurrentSubagents);
  let counter = 0;

  return {
    name: SUBAGENT_TOOL_NAME,
    description: `Run a self-contained task in a separate agent that works in parallel with you. It does not see your conversation. Returns its finish result (status and summary). At most ${config.maxConcurrentSubagents} run at once. Extra calls wait for a free slot.`,
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Complete, self-contained instructions, including paths and the expected output.",
        },
        model: { type: "string", enum: models, description: `Default: ${models[0]}` },
        deny: {
          type: "array",
          items: { type: "string", enum: [...NARROWABLE] },
          description:
            'Optionally remove permissions for this subagent, e.g. ["write", "delete"] for a read-only researcher.',
        },
      },
      required: ["task"],
    },
    async run(input): Promise<ToolOutput> {
      const i = input as { task?: unknown; model?: unknown; deny?: unknown };
      if (typeof i.task !== "string" || !i.task.trim()) {
        return { text: 'subagent: "task" is required.', isError: true };
      }
      const model = i.model === undefined ? models[0] : i.model;
      if (typeof model !== "string" || !models.includes(model)) {
        return { text: `subagent: "model" must be one of ${models.join(", ")}.`, isError: true };
      }
      const deny = Array.isArray(i.deny) ? i.deny : [];
      const perms = narrow(config.permissions, deny);
      const agentId = `sub-${++counter}`;
      const task = i.task;

      return limit(async () => {
        const tools = opts.buildTools(perms);
        const brief = runBrief(
          { ...config, permissions: perms },
          [...tools.map((t) => t.name), "finish"],
          { subagent: true, bashDisabledReason: opts.bashDisabledReason(perms) },
        );
        deps.logger.log({ type: "subagent_start", agentId, model, task });
        const out = await runAgent(
          {
            agentId,
            namespace: opts.namespace,
            title: `${agentId}: ${task.slice(0, 60)}`,
            prompt: taskPrompt(SUBAGENT_RULES, brief, task, "parent agent"),
            model,
            tools,
          },
          { ...deps, config: { ...config, permissions: perms } },
        );
        const status = out.status === "interrupted" ? "error" : out.status;
        deps.logger.log({
          type: "subagent_finish",
          agentId,
          status: statusForLog(status),
          summary: out.summary,
        });
        opts.summaries.push({
          id: agentId,
          model,
          task,
          status,
          summary: out.summary,
          chatId: out.chatId,
        });
        return {
          text: JSON.stringify({
            status: out.status,
            summary: out.summary,
            reason: out.reason || undefined,
            clarifications: out.clarifications.length ? out.clarifications : undefined,
          }),
          isError: out.status !== "success",
        };
      });
    },
  };
}

function statusForLog(s: SubagentSummary["status"]): "success" | "failed" | "needs_clarification" {
  return s === "success" || s === "needs_clarification" ? s : "failed";
}

function narrow(base: Permissions, deny: unknown[]): Permissions {
  const has = (k: string) => deny.includes(k);
  return {
    ...base,
    fs: {
      ...base.fs,
      read: base.fs.read && !has("read"),
      write: base.fs.write && !has("write"),
      delete: base.fs.delete && !has("delete"),
    },
    network: base.network && !has("network"),
  };
}

/** Minimal concurrency limiter. */
function pLimit(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
