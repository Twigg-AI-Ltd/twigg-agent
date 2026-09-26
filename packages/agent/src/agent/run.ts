import { basename } from "node:path";
import type { TwiggClient } from "../core/client.js";
import type { Logger, Permissions, RunConfig, RunResult, SubagentSummary } from "../core/types.js";
import { bashDisabledReason } from "../permissions/index.js";
import { type CustomTool, loadCustomTools } from "../tools/custom.js";
import { buildTools } from "../tools/index.js";
import { Budget } from "./budget.js";
import { type AgentOutcome, runAgent } from "./loop.js";
import { agentNamespaces } from "./namespace.js";
import { MAIN_RULES, runBrief, taskPrompt } from "./prompts.js";
import { createSubagentTool } from "./subagent.js";

export async function runMain(
  config: RunConfig,
  client: TwiggClient,
  logger: Logger,
  signal: AbortSignal,
): Promise<RunResult> {
  const budget = new Budget(config.limits, logger, config.progressEvery);
  const subagents: SubagentSummary[] = [];
  const ns = agentNamespaces(config.namespace);
  logger.log({
    type: "run_start",
    model: config.model,
    // The full Twigg path the main agent's chat lives in.
    namespace: ns.main,
    instructionsPath: config.instructionsPath,
  });
  const bashNotice = bashNoticeFor(config.permissions);
  if (bashNotice) logger.log({ type: "config_notice", message: bashNotice });

  const finalize = async (o: AgentOutcome): Promise<RunResult> => {
    await settleCosts(client, budget);
    return {
      status: o.status,
      summary: o.summary,
      reason: o.reason,
      clarifications: o.clarifications,
      ...(o.limitHit ? { limitHit: o.limitHit } : {}),
      model: o.model,
      ...(o.chatId ? { chatId: o.chatId } : {}),
      runIds: budget.runIds,
      turns: budget.turns,
      tokens: { ...budget.tokens },
      costUsd: budget.costUsd,
      durationMs: budget.elapsedMs,
      subagents,
    };
  };
  const setupError = (reason: string) =>
    finalize({
      status: "error",
      summary: "Setup failed.",
      reason,
      clarifications: [],
      model: config.model,
    });

  // Setup: validate models.
  try {
    const names = new Set(await client.listModelNames());
    const wanted = [config.model, config.fallbackModel, ...config.subagentModels].filter(
      (m): m is string => m !== undefined,
    );
    const unknown = wanted.filter((m) => !names.has(m));
    if (unknown.length) return setupError(`unknown or inactive model(s): ${unknown.join(", ")}`);
  } catch (e) {
    return setupError(`Twigg setup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Tools are listed on purpose, so one that can't be used stops the run before it starts.
  const custom: CustomTool[] = [];
  const problems: string[] = [];
  for (const entry of await loadCustomTools(config.tools)) {
    if ("tool" in entry) custom.push(entry.tool);
    else problems.push(`${entry.name}: ${entry.problem}`);
  }
  if (problems.length) return setupError(`custom tool(s) not ready: ${problems.join("; ")}`);
  const build = (perms: Permissions) => buildTools(perms, custom);

  const deps = { client, config, logger, budget, signal };
  const tools = build(config.permissions);
  if (config.subagentModels.length && !config.permissions.disabledTools.includes("subagent")) {
    tools.push(
      createSubagentTool({
        deps,
        namespace: ns.subagent,
        buildTools: build,
        bashDisabledReason,
        summaries: subagents,
      }),
    );
  }
  const reason = bashDisabledReason(config.permissions);

  const brief = runBrief(config, [...tools.map((t) => t.name), "finish"], {
    bashDisabledReason: reason,
  });
  const outcome = await runAgent(
    {
      agentId: "main",
      namespace: ns.main,
      title: basename(config.instructionsPath),
      prompt: taskPrompt(MAIN_RULES, brief, config.task, config.instructionsPath),
      model: config.model,
      ...(config.fallbackModel ? { fallbackModel: config.fallbackModel } : {}),
      tools,
    },
    deps,
  );
  return finalize(outcome);
}

/** What to tell the user at the start of the run when bash is off; undefined when it is on. */
function bashNoticeFor(perms: Permissions): string | undefined {
  const reason = bashDisabledReason(perms);
  if (!reason) return undefined;
  if (!perms.bash) {
    return 'bash is disabled by default. Enable it with --allow-bash (or "permissions": { "bash": true } in settings). It runs without a sandbox, so use a VM or container.';
  }
  return `bash disabled: ${reason}`;
}

/** Pick up costs that were still settling when their turn ended. Best effort, briefly. */
async function settleCosts(client: TwiggClient, budget: Budget): Promise<void> {
  const pending = budget.unsettledRunIds.splice(0);
  for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000));
    for (const id of [...pending]) {
      try {
        const run = await client.getRun(id);
        if (run.cost !== null) {
          budget.costUsd += Math.abs(Number(run.cost));
          pending.splice(pending.indexOf(id), 1);
        }
      } catch {
        // leave it pending
      }
    }
  }
}
