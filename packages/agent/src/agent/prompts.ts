import type { RunConfig } from "../core/types.js";
import { fmtDuration } from "./budget.js";

// Harness operating rules. The system prompt belongs to the user (set per namespace on the Twigg
// dashboard), so these travel in the first message, ahead of the run brief and the instructions.

const SHARED_RULES = `
- Nobody will answer questions. You cannot ask for clarification. Work out the intent from the
  instructions. When something is ambiguous but a reasonable interpretation exists, choose it and
  state the assumption in your finish summary. Only when a critical ambiguity makes any reasonable
  attempt risky or meaningless, call \`finish\` with status \`needs_clarification\` and list the
  questions that must be answered.
- Your plain-text replies are only written to a log. Nobody reads them during the run. Deliverables
  are what the instructions ask for, such as files, commands and changes, and you produce them with
  tools.
- If a tool result says the user has blocked an action, do not look for another way to do it. Call
  \`finish\` with status \`failed\` and say what you tried and that it was blocked.
- The first message lists the run's limits and restrictions. Plan within them. If the task clearly
  cannot be done within them, call \`finish\` with status \`failed\` straight away and explain why.
  When the harness warns that a limit is close, wrap up and call \`finish\`.
- Use \`todo\` to plan and track multi-step work.
- Be efficient: batch independent tool calls in one turn, and do not re-read files you already have.
- End every run by calling \`finish\` exactly once, with a short, factual summary. Tool calls made
  in the same turn as \`finish\` run first.`;

export const MAIN_RULES = `You are running as twigg-agent, an autonomous agent that runs one-shot and non-interactively in a terminal.
You receive an instructions file and complete it end to end using your tools.

Rules:${SHARED_RULES}
- \`subagent\` (when available) runs an independent task in parallel on its own. Subagents do not see
  your conversation, so give each one a complete, self-contained task that includes the relevant
  paths and the expected output. Use them for independent work, not for trivial steps. A subagent's
  finish result comes back to you as the tool result. If one reports \`needs_clarification\`, decide
  yourself when you can.`;

export const SUBAGENT_RULES = `You are running as a twigg-agent subagent. A parent agent gave you a self-contained task and runs
you non-interactively. Complete the task using your tools. Your \`finish\` result is returned to the
parent agent, and it is the only thing the parent sees, so make the summary contain what the parent
needs (findings, paths written, decisions). You cannot start subagents yourself.

Rules:${SHARED_RULES}`;

/** Restrictions and limits, stated up front so the agent can plan or fail fast. */
export function runBrief(
  config: RunConfig,
  toolNames: string[],
  opts: { bashDisabledReason?: string; subagent?: boolean; now?: Date },
): string {
  const { permissions: p, limits } = config;
  const lines: string[] = ["[twigg-agent harness] Run brief"];
  lines.push(`Today: ${localDate(opts.now ?? new Date())}`);
  lines.push(`Working directory: ${config.cwd}`);
  lines.push(`Tools: ${toolNames.join(", ")}`);

  const restrictions: string[] = [];
  if (p.fs.root !== "/") restrictions.push(`File tools may only access files under ${p.fs.root}`);
  if (p.protectedPaths.length) {
    restrictions.push(
      `Protected files must not be read, written, edited, deleted or used in bash commands: ${p.protectedPaths.join(", ")}`,
    );
  }
  if (!p.fs.read) restrictions.push("Reading files is blocked");
  if (!p.fs.write) restrictions.push("Writing and editing files is blocked");
  if (!p.fs.delete) restrictions.push("Deleting files is blocked");
  if (!p.network) restrictions.push("Network access is blocked");
  if (p.disabledTools.length) restrictions.push(`Disabled tools: ${p.disabledTools.join(", ")}`);
  if (opts.bashDisabledReason) restrictions.push(`bash is unavailable: ${opts.bashDisabledReason}`);
  lines.push(
    restrictions.length
      ? `Restrictions (set by the user, do not work around them):\n${restrictions.map((r) => `- ${r}`).join("\n")}`
      : "Restrictions: none",
  );

  const limitLines = [
    `- turns (model calls, shared across all agents): ${limits.maxTurns}`,
    `- wall clock: ${fmtDuration(limits.timeoutMs)}`,
    `- per tool call: ${fmtDuration(limits.toolTimeoutMs)}`,
  ];
  if (limits.maxCostUsd !== undefined) limitLines.push(`- cost: $${limits.maxCostUsd.toFixed(2)}`);
  lines.push(`Limits (the run stops when any is reached):\n${limitLines.join("\n")}`);

  if (!opts.subagent && config.subagentModels.length) {
    lines.push(
      `Subagents: models ${config.subagentModels.join(", ")}; at most ${config.maxConcurrentSubagents} at once; they share these limits.`,
    );
  }
  return lines.join("\n");
}

/** `2026-09-25 (Friday)` in local time. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} (${weekday})`;
}

/** The first message: harness rules, then the run brief, then the task itself. */
export function taskPrompt(rules: string, brief: string, task: string, source: string): string {
  return `[twigg-agent harness] Operating rules\n${rules}\n\n${brief}\n\n[instructions: ${source}]\n\n${task}`;
}
