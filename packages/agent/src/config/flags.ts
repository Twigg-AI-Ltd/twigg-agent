import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import {
  ConfigError,
  type FileConfig,
  NAMESPACE_RE,
  parseDuration,
  REASONING_EFFORTS,
} from "./schema.js";

export const VERSION: string = pkg.version;

export const HELP = `twigg-agent ${VERSION}

Run a one-shot, non-interactive agent against the Twigg API.

Usage:
  twigg-agent <instructions.md> [options]
  twigg-agent models                                                List the models you can use
  twigg-agent tools [--tool <pkg|path>] [--settings <file.json>]   List custom tools

Needs a Twigg API key in TWIGG_API_KEY (the environment or ./.env). Create one at
https://twigg.ai.

The instructions file may start with YAML frontmatter (between --- lines) using the same keys
as the settings file. Frontmatter may only tighten permissions, limits and subagents.
Precedence: flags > frontmatter > settings file > defaults.

Model:
  --model <name>                     Model to run (required here, in frontmatter or settings)
  --fallback-model <name>            Model to switch to if the main model fails
  --namespace <ns>                   Twigg namespace, always under twigg-agent/ (default: local)
  --max-tokens <n>                   Max output tokens per model call
  --reasoning-effort <e>             off|low|medium|high|x_high|max

Settings:
  --settings <file.json>             Load settings from a JSON file
  --cwd <dir>                        Working directory for tools (default: current dir)

Permissions:
  --root <dir>                       Restrict file tools to this directory (default: --cwd)
  --no-read                          Disallow reading files
  --no-write                         Disallow writing files
  --no-delete                        Disallow deleting files
  --no-network                       Disallow network access for tools
  --allow-bash                       Offer the bash tool. Off by default: it runs without a
                                     sandbox, so only use it in a VM or container
  --disable-tool <name>              Disable a tool (repeatable)
  --protect <glob>                   Also protect matching files from all tools (repeatable;
                                     .env, keys and credentials are always protected)

Custom tools:
  --tool <pkg|path>                  Add a custom tool: an npm package or a folder with a
                                     tool.json (repeatable; adds to "tools" in settings)

Subagents:
  --subagent-model <name>            Model subagents may use (repeatable; default: --model)
  --max-concurrent-subagents <n>     Max subagents running at once (default: 3)

Limits:
  --max-cost <usd>                   Stop when the run costs this much (default: none)
  --max-turns <n>                    Max model calls across all agents (default: 100)
  --timeout <dur>                    Whole-run timeout, e.g. 90s, 30m, 1h or ms (default: 30m)
  --tool-timeout <dur>               Per tool call timeout (default: 2m)
  --warn-at <0-1>                    Warn the agent at this fraction of a limit (default: 0.8)

Output:
  --output <file.json>               Write the run result as JSON to this file
  --log-format human|json            Log format on stderr (default: human)
  --log-file <file>                  Also append JSON log events to this file
  --progress-every <n>               Log a progress line every N turns (default: 5)

  -h, --help                         Show this help
  -v, --version                      Show the version`;

export interface ParsedFlags {
  kind: "run" | "models" | "tools" | "help" | "version";
  instructions?: string;
  settings?: string;
  cwd?: string;
  /** Flag values in settings-file shape; paths not yet resolved. */
  config: FileConfig;
}

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  model: { type: "string" },
  "fallback-model": { type: "string" },
  namespace: { type: "string" },
  settings: { type: "string" },
  cwd: { type: "string" },
  root: { type: "string" },
  "no-read": { type: "boolean" },
  "no-write": { type: "boolean" },
  "no-delete": { type: "boolean" },
  "no-network": { type: "boolean" },
  "allow-bash": { type: "boolean" },
  "disable-tool": { type: "string", multiple: true },
  protect: { type: "string", multiple: true },
  tool: { type: "string", multiple: true },
  "subagent-model": { type: "string", multiple: true },
  "max-concurrent-subagents": { type: "string" },
  "max-cost": { type: "string" },
  "max-turns": { type: "string" },
  timeout: { type: "string" },
  "tool-timeout": { type: "string" },
  "warn-at": { type: "string" },
  "max-tokens": { type: "string" },
  "reasoning-effort": { type: "string" },
  output: { type: "string" },
  "log-format": { type: "string" },
  "log-file": { type: "string" },
  "progress-every": { type: "string" },
} as const;

function posInt(flag: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < 1)
    throw new ConfigError(`--${flag}: expected a positive integer, got "${v}"`);
  return Number(v);
}

function duration(flag: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const ms = parseDuration(v);
  if (ms === undefined)
    throw new ConfigError(`--${flag}: invalid duration "${v}" (use e.g. 90s, 30m, 1h or ms)`);
  return ms;
}

function nonEmpty(flag: string, v: string | undefined): string | undefined {
  if (v === "") throw new ConfigError(`--${flag}: must not be empty`);
  return v;
}

/** Removes undefined-valued keys so spreading never overwrites with undefined. */
function compact<T extends object>(o: T): T | undefined {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return Object.keys(out).length ? out : undefined;
}

function toolFlags(v: string[] | undefined): string[] | undefined {
  if (v?.some((t) => t === "")) throw new ConfigError("--tool: must not be empty");
  return v;
}

function parseStrict(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
}

export function parseFlags(argv: string[]): ParsedFlags {
  const { values: v, positionals } = parseStrict(argv);
  if (v.help) return { kind: "help", config: {} };
  if (v.version) return { kind: "version", config: {} };
  if (positionals.length === 1 && positionals[0] === "models")
    return { kind: "models", config: {} };
  if (positionals.length === 1 && positionals[0] === "tools") {
    return {
      kind: "tools",
      settings: nonEmpty("settings", v.settings),
      config: compact({ tools: toolFlags(v.tool) }) ?? {},
    };
  }
  if (positionals.length === 0)
    throw new ConfigError("missing <instructions.md> argument (see --help)");
  if (positionals.length > 1) {
    throw new ConfigError(`expected one instructions file, got: ${positionals.join(", ")}`);
  }

  const namespace = nonEmpty("namespace", v.namespace);
  if (namespace !== undefined && !NAMESPACE_RE.test(namespace)) {
    throw new ConfigError(`--namespace: "${namespace}" must match ${NAMESPACE_RE.source}`);
  }
  const effort = v["reasoning-effort"];
  if (effort !== undefined && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new ConfigError(
      `--reasoning-effort: expected ${REASONING_EFFORTS.join("|")}, got "${effort}"`,
    );
  }
  const logFormat = v["log-format"];
  if (logFormat !== undefined && logFormat !== "human" && logFormat !== "json") {
    throw new ConfigError(`--log-format: expected human|json, got "${logFormat}"`);
  }
  let maxCostUsd: number | undefined;
  if (v["max-cost"] !== undefined) {
    maxCostUsd = Number(v["max-cost"]);
    if (!v["max-cost"].trim() || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      throw new ConfigError(`--max-cost: expected a positive number, got "${v["max-cost"]}"`);
    }
  }
  let warnAt: number | undefined;
  if (v["warn-at"] !== undefined) {
    warnAt = Number(v["warn-at"]);
    if (!v["warn-at"].trim() || !(warnAt > 0 && warnAt < 1)) {
      throw new ConfigError(
        `--warn-at: expected a number between 0 and 1 (exclusive), got "${v["warn-at"]}"`,
      );
    }
  }

  const config: FileConfig = {
    model: nonEmpty("model", v.model),
    fallbackModel: nonEmpty("fallback-model", v["fallback-model"]),
    namespace,
    permissions: compact({
      root: nonEmpty("root", v.root),
      read: v["no-read"] ? false : undefined,
      write: v["no-write"] ? false : undefined,
      delete: v["no-delete"] ? false : undefined,
      network: v["no-network"] ? false : undefined,
      bash: v["allow-bash"] ? true : undefined,
      disabledTools: v["disable-tool"],
      protectedPaths: v.protect,
    }),
    limits: compact({
      maxCostUsd,
      maxTurns: posInt("max-turns", v["max-turns"]),
      timeout: duration("timeout", v.timeout),
      toolTimeout: duration("tool-timeout", v["tool-timeout"]),
      warnAt,
    }),
    subagents: compact({
      models: v["subagent-model"],
      maxConcurrent: posInt("max-concurrent-subagents", v["max-concurrent-subagents"]),
    }),
    maxTokens: posInt("max-tokens", v["max-tokens"]),
    reasoningEffort: effort as FileConfig["reasoningEffort"],
    output: nonEmpty("output", v.output),
    logFormat,
    logFile: nonEmpty("log-file", v["log-file"]),
    progressEvery: posInt("progress-every", v["progress-every"]),
    tools: toolFlags(v.tool),
  };
  return {
    kind: "run",
    instructions: positionals[0],
    settings: nonEmpty("settings", v.settings),
    cwd: nonEmpty("cwd", v.cwd),
    config: compact(config) ?? {},
  };
}
