import * as s from "../core/schema.js";

/** Invalid configuration. The message names the offending flag or field. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export const REASONING_EFFORTS = ["off", "low", "medium", "high", "x_high", "max"] as const;
export const NAMESPACE_RE = /^[a-z0-9_-]{1,64}(\/[a-z0-9_-]{1,64})*$/;

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** Parses `90s`, `30m`, `1h`, `250ms` or plain milliseconds. Returns undefined if invalid. */
export function parseDuration(value: string | number): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(value);
  if (!m) return undefined;
  const ms = Math.round(Number(m[1]) * (UNITS[m[2] ?? "ms"] ?? 1));
  return ms > 0 ? ms : undefined;
}

const duration = s.custom(
  { type: ["number", "string"] },
  (v) => (typeof v === "number" || typeof v === "string" ? parseDuration(v) : undefined),
  (v) => `invalid duration ${JSON.stringify(v)}`,
);

const text = s.string({ min: 1 });
const posInt = s.number({ int: true, gt: 0 });

/** Shared schema of the settings file and the instructions-file frontmatter. */
export const FileConfigSchema = s.object(
  {
    model: text.optional(),
    fallbackModel: text.optional(),
    namespace: s
      .string({
        pattern: NAMESPACE_RE,
        message: "must match ^[a-z0-9_-]{1,64}(/[a-z0-9_-]{1,64})*$",
      })
      .optional(),
    permissions: s
      .object(
        {
          root: text.optional(),
          read: s.boolean().optional(),
          write: s.boolean().optional(),
          delete: s.boolean().optional(),
          network: s.boolean().optional(),
          /** Offer the unsandboxed bash tool. Off by default; frontmatter can't turn it on. */
          bash: s.boolean().optional(),
          disabledTools: s.array(text).optional(),
          protectedPaths: s.array(text).optional(),
        },
        "strict",
      )
      .optional(),
    limits: s
      .object(
        {
          maxCostUsd: s.number({ gt: 0 }).optional(),
          maxTurns: posInt.optional(),
          timeout: duration.optional(),
          toolTimeout: duration.optional(),
          warnAt: s.number({ gt: 0, lt: 1 }).optional(),
        },
        "strict",
      )
      .optional(),
    subagents: s
      .object({ models: s.array(text).optional(), maxConcurrent: posInt.optional() }, "strict")
      .optional(),
    maxTokens: posInt.optional(),
    reasoningEffort: s.oneOf(REASONING_EFFORTS).optional(),
    output: text.optional(),
    logFormat: s.oneOf(["human", "json"]).optional(),
    logFile: text.optional(),
    progressEvery: posInt.optional(),
    /**
     * Custom tools: npm package names or folder paths, optionally with environment values for the
     * tool. Settings and flags only, not frontmatter.
     */
    tools: s
      .array(s.union(text, s.object({ use: text, env: s.record(s.string()).optional() }, "strict")))
      .optional(),
  },
  "strict",
);

/** Parsed file config; durations are milliseconds. */
export type FileConfig = s.Infer<typeof FileConfigSchema>;

/** Validates raw settings/frontmatter data; `source` prefixes error messages. */
export function parseFileConfig(data: unknown, source: string): FileConfig {
  const res = FileConfigSchema.parse(data ?? {});
  if (res.ok) return res.value;
  const issue = res.issues[0];
  throw new ConfigError(`${source}: ${issue?.path || "(root)"}: ${issue?.message ?? "invalid"}`);
}
