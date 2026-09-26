import type { DoneData } from "../core/client.js";
import type { LimitName, Limits, Logger, TokenTotals } from "../core/types.js";

/**
 * Run-wide usage shared by the main agent and every subagent. Enforces limits, decides when each
 * agent gets its one-off "wrap up" warning, and emits progress lines.
 */
export class Budget {
  turns = 0;
  costUsd = 0;
  readonly tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  readonly runIds: string[] = [];
  /** Runs whose cost was still settling when the turn finished. */
  readonly unsettledRunIds: string[] = [];
  private readonly startedAt = Date.now();
  private lastProgressAt = 0;
  /** agentId → limits already warned about. */
  private readonly warned = new Map<string, Set<LimitName>>();

  constructor(
    readonly limits: Limits,
    private readonly logger: Logger,
    private readonly progressEvery: number,
  ) {}

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.limits.timeoutMs - this.elapsedMs);
  }

  /** Call before each model submission. */
  startTurn(): void {
    this.turns++;
  }

  record(runId: string, done: DoneData | undefined): void {
    this.runIds.push(runId);
    if (!done) return;
    this.tokens.input += done.usage.input;
    this.tokens.output += done.usage.output;
    this.tokens.cacheRead += done.usage.cacheRead;
    this.tokens.cacheWrite += done.usage.cacheWrite;
    this.tokens.reasoning += done.usage.reasoning;
    if (done.cost === null) this.unsettledRunIds.push(runId);
    else this.costUsd += done.cost;
    // Concurrent agents can finish turns out of order, so log once per crossed step.
    if (this.progressEvery > 0 && this.turns - this.lastProgressAt >= this.progressEvery) {
      this.lastProgressAt = this.turns - (this.turns % this.progressEvery);
      this.logProgress();
    }
  }

  logProgress(): void {
    this.logger.log({
      type: "progress",
      turns: this.turns,
      tokens: { ...this.tokens },
      costUsd: this.costUsd,
      elapsedMs: this.elapsedMs,
    });
  }

  private usage(): { limit: LimitName; used: number; max: number }[] {
    const out: { limit: LimitName; used: number; max: number }[] = [
      { limit: "turns", used: this.turns, max: this.limits.maxTurns },
      { limit: "time", used: this.elapsedMs, max: this.limits.timeoutMs },
    ];
    if (this.limits.maxCostUsd !== undefined) {
      out.push({ limit: "cost", used: this.costUsd, max: this.limits.maxCostUsd });
    }
    return out;
  }

  /** The first limit that is used up, if any. */
  exceeded(): LimitName | undefined {
    return this.usage().find((u) => u.used >= u.max)?.limit;
  }

  /**
   * Limits past the warning threshold that this agent has not been told about yet. Marks them as
   * warned, logs them, and returns the text to inject into the agent's next submission.
   */
  takeWarnings(agentId: string): string | undefined {
    let seen = this.warned.get(agentId);
    if (!seen) {
      seen = new Set();
      this.warned.set(agentId, seen);
    }
    const due = this.usage().filter(
      (u) => u.used >= u.max * this.limits.warnAt && !seen.has(u.limit),
    );
    if (due.length === 0) return undefined;
    for (const u of due) {
      seen.add(u.limit);
      this.logger.log({ type: "limit_warning", limit: u.limit, used: u.used, max: u.max });
    }
    const lines = due.map((u) => `- ${describe(u.limit, u.used, u.max)}`);
    return [
      "[twigg-agent harness] Limit warning:",
      ...lines,
      "The run stops automatically when any limit is reached. Wrap up now: finish only the essential",
      "remaining work, then call `finish`. If the task cannot be completed in what is left, call",
      "`finish` with status `failed` and say how far you got.",
    ].join("\n");
  }
}

export function describe(limit: LimitName, used: number, max: number): string {
  switch (limit) {
    case "turns":
      return `turns: ${used} of ${max} used, ${Math.max(0, max - used)} left`;
    case "time":
      return `time: ${fmtDuration(used)} of ${fmtDuration(max)} used, ${fmtDuration(Math.max(0, max - used))} left`;
    case "cost":
      return `cost: $${used.toFixed(4)} of $${max.toFixed(2)} used, $${Math.max(0, max - used).toFixed(4)} left`;
  }
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
}
