import { z } from "zod";

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

const duration = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const ms = parseDuration(v);
  if (ms === undefined) {
    ctx.addIssue({ code: "custom", message: `invalid duration ${JSON.stringify(v)}` });
    return z.NEVER;
  }
  return ms;
});

const posInt = z.number().int().positive();

/** Shared schema of the settings file and the instructions-file frontmatter. */
export const FileConfigSchema = z.strictObject({
  model: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional(),
  namespace: z
    .string()
    .regex(NAMESPACE_RE, "must match ^[a-z0-9_-]{1,64}(/[a-z0-9_-]{1,64})*$")
    .optional(),
  permissions: z
    .strictObject({
      root: z.string().min(1).optional(),
      read: z.boolean().optional(),
      write: z.boolean().optional(),
      delete: z.boolean().optional(),
      network: z.boolean().optional(),
      /** Offer the unsandboxed bash tool. Off by default; frontmatter can't turn it on. */
      bash: z.boolean().optional(),
      disabledTools: z.array(z.string().min(1)).optional(),
      protectedPaths: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  limits: z
    .strictObject({
      maxCostUsd: z.number().positive().optional(),
      maxTurns: posInt.optional(),
      timeout: duration.optional(),
      toolTimeout: duration.optional(),
      warnAt: z.number().gt(0).lt(1).optional(),
    })
    .optional(),
  subagents: z
    .strictObject({
      models: z.array(z.string().min(1)).optional(),
      maxConcurrent: posInt.optional(),
    })
    .optional(),
  maxTokens: posInt.optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  output: z.string().min(1).optional(),
  logFormat: z.enum(["human", "json"]).optional(),
  logFile: z.string().min(1).optional(),
  progressEvery: posInt.optional(),
  /**
   * Custom tools: npm package names or folder paths, optionally with environment values for the
   * tool. Settings and flags only, not frontmatter.
   */
  tools: z
    .array(
      z.union([
        z.string().min(1),
        z.strictObject({
          use: z.string().min(1),
          env: z.record(z.string(), z.string()).optional(),
        }),
      ]),
    )
    .optional(),
});

/** Parsed file config; durations are milliseconds. */
export type FileConfig = z.output<typeof FileConfigSchema>;

/** Validates raw settings/frontmatter data; `source` prefixes error messages. */
export function parseFileConfig(data: unknown, source: string): FileConfig {
  const res = FileConfigSchema.safeParse(data ?? {});
  if (res.success) return res.data;
  const issue = res.error.issues[0];
  const path = issue?.path.join(".") || "(root)";
  let msg = issue?.message ?? "invalid";
  if (issue?.code === "unrecognized_keys") msg = `unknown key(s) ${issue.keys.join(", ")}`;
  throw new ConfigError(`${source}: ${path}: ${msg}`);
}
