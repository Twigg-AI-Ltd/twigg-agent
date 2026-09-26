import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { agentNamespaces } from "../agent/namespace.js";
import type { RunConfig, ToolSource } from "../core/types.js";
import { DEFAULT_PROTECTED_PATHS } from "../permissions/index.js";
import { resolveToolDir, STATE_DIR } from "../tools/custom.js";
import { HELP, parseFlags, VERSION } from "./flags.js";
import { ConfigError, type FileConfig, parseFileConfig } from "./schema.js";

export { HELP } from "./flags.js";
export { ConfigError, parseDuration } from "./schema.js";

export type LoadConfigResult =
  | { kind: "run"; config: RunConfig }
  | { kind: "tools"; tools: ToolSource[] }
  | { kind: "help" | "version"; text: string };

const DEFAULTS = {
  maxTurns: 100,
  timeoutMs: 30 * 60_000,
  toolTimeoutMs: 2 * 60_000,
  warnAt: 0.8,
  maxConcurrent: 3,
  namespace: "local",
  progressEvery: 5,
} as const;

/**
 * Resolves the run configuration from argv, the optional settings file and the instructions
 * file's frontmatter. Precedence: flags > frontmatter > settings > defaults, except that
 * frontmatter may only tighten permissions, limits and subagents relative to settings + flags.
 */
export async function loadConfig(
  argv: string[],
  opts: { cwd?: string } = {},
): Promise<LoadConfigResult> {
  const flags = parseFlags(argv);
  if (flags.kind === "help") return { kind: "help", text: HELP };
  if (flags.kind === "version") return { kind: "version", text: VERSION };

  const invCwd = path.resolve(opts.cwd ?? process.cwd());
  const settingsFile = flags.settings ? path.resolve(invCwd, flags.settings) : undefined;
  const settings = settingsFile ? await readSettings(settingsFile) : ({} as FileConfig);
  const flagCfg = resolvePaths(flags.config, invCwd);
  // Settings tools resolve against the settings file, --tool ones against the invocation dir. An
  // instructions file must not be able to add tools.
  const tools = await resolveTools([
    ...toolSpecs(settings.tools, settingsFile ? path.dirname(settingsFile) : invCwd),
    ...toolSpecs(flagCfg.tools, invCwd),
  ]);
  if (flags.kind === "tools") return { kind: "tools", tools };

  const instructionsPath = flags.instructions as string;
  const { frontmatter, task } = await readInstructions(path.resolve(invCwd, instructionsPath));
  if (frontmatter.tools !== undefined) {
    throw new ConfigError("frontmatter: tools can only be set by flags or the settings file");
  }
  const fm = resolvePaths(frontmatter, invCwd);

  // Base the frontmatter is layered against: settings overridden by flags.
  const base: FileConfig = {
    ...settings,
    ...flagCfg,
    permissions: {
      ...settings.permissions,
      ...flagCfg.permissions,
      disabledTools: union(settings.permissions?.disabledTools, flagCfg.permissions?.disabledTools),
      protectedPaths: union(
        settings.permissions?.protectedPaths,
        flagCfg.permissions?.protectedPaths,
      ),
    },
    limits: { ...settings.limits, ...flagCfg.limits },
    subagents: { ...settings.subagents, ...flagCfg.subagents },
  };
  // Free fields: flags > frontmatter > settings.
  const pick = <K extends keyof FileConfig>(k: K): FileConfig[K] =>
    flagCfg[k] ?? fm[k] ?? settings[k];

  const model = pick("model");
  if (!model) throw new ConfigError("model: required (use --model, frontmatter or settings)");

  const bp = base.permissions ?? {};
  const fp = fm.permissions ?? {};
  const bool = (k: "read" | "write" | "delete" | "network"): boolean => {
    const b = bp[k] ?? true;
    if (fp[k] === true && !b) {
      throw new ConfigError(
        `frontmatter: permissions.${k} cannot re-enable what settings/flags disabled`,
      );
    }
    return fp[k] ?? b;
  };
  // Bash is off unless settings or flags turn it on; frontmatter may only turn it off.
  const allowBash = (): boolean => {
    const b = bp.bash ?? false;
    if (fp.bash === true && !b) {
      throw new ConfigError(
        "frontmatter: permissions.bash cannot enable bash; use --allow-bash or the settings file",
      );
    }
    return fp.bash ?? b;
  };
  // Tools work in the working directory, and by default may not leave it.
  const cwd = flags.cwd ? path.resolve(invCwd, flags.cwd) : invCwd;
  await assertDir(cwd, "--cwd");
  const baseRoot = bp.root ?? cwd;
  if (fp.root !== undefined && !isInside(fp.root, baseRoot)) {
    throw new ConfigError(
      `frontmatter: permissions.root "${fp.root}" must be inside "${baseRoot}"`,
    );
  }
  const root = fp.root ?? baseRoot;

  const bl = base.limits ?? {};
  const fl = fm.limits ?? {};
  const lower = (field: string, b: number | undefined, f: number | undefined) => {
    if (f !== undefined && b !== undefined && f > b) {
      throw new ConfigError(`frontmatter: ${field} ${f} may only lower the configured value ${b}`);
    }
    return f ?? b;
  };

  const baseModels = base.subagents?.models ?? [model];
  const fmModels = fm.subagents?.models;
  const extra = fmModels?.filter((m) => !baseModels.includes(m)) ?? [];
  if (extra.length) {
    throw new ConfigError(
      `frontmatter: subagents.models may only narrow the allowed list (${baseModels.join(", ")}); not allowed: ${extra.join(", ")}`,
    );
  }

  await assertDir(root, "permissions.root");

  // The harness prefixes "twigg-agent/" and appends "/main" or "/subagent"; Twigg caps paths at 255.
  const namespace = pick("namespace") ?? DEFAULTS.namespace;
  if (agentNamespaces(namespace).subagent.length > 255) {
    throw new ConfigError(`namespace: "${namespace}" is too long once prefixed (max 255 bytes)`);
  }

  const config: RunConfig = {
    instructionsPath,
    task,
    model,
    fallbackModel: pick("fallbackModel"),
    namespace,
    subagentModels: fmModels ?? baseModels,
    maxConcurrentSubagents: lower(
      "subagents.maxConcurrent",
      base.subagents?.maxConcurrent ?? DEFAULTS.maxConcurrent,
      fm.subagents?.maxConcurrent,
    ) as number,
    maxTokens: pick("maxTokens"),
    reasoningEffort: pick("reasoningEffort"),
    permissions: {
      fs: { root, read: bool("read"), write: bool("write"), delete: bool("delete") },
      network: bool("network"),
      bash: allowBash(),
      disabledTools: union(bp.disabledTools, fp.disabledTools),
      // Additive only: the defaults always apply and no source can remove a pattern. Custom
      // tools' folders and their state are always protected; tools reach them, the agent can't.
      protectedPaths: union(
        [
          ...DEFAULT_PROTECTED_PATHS,
          ...(tools.length ? [`${path.join(cwd, STATE_DIR)}/**`] : []),
          ...tools.flatMap((t) => (t.dir ? [`${t.dir}/**`] : [])),
        ],
        union(bp.protectedPaths, fp.protectedPaths),
      ),
    },
    limits: {
      maxCostUsd: lower("limits.maxCostUsd", bl.maxCostUsd, fl.maxCostUsd),
      maxTurns: lower("limits.maxTurns", bl.maxTurns ?? DEFAULTS.maxTurns, fl.maxTurns) as number,
      timeoutMs: lower("limits.timeout", bl.timeout ?? DEFAULTS.timeoutMs, fl.timeout) as number,
      toolTimeoutMs: lower(
        "limits.toolTimeout",
        bl.toolTimeout ?? DEFAULTS.toolTimeoutMs,
        fl.toolTimeout,
      ) as number,
      warnAt: lower("limits.warnAt", bl.warnAt ?? DEFAULTS.warnAt, fl.warnAt) as number,
    },
    outputPath: pick("output"),
    logFormat: pick("logFormat") ?? "human",
    logFile: pick("logFile"),
    progressEvery: pick("progressEvery") ?? DEFAULTS.progressEvery,
    cwd,
    tools,
  };
  return { kind: "run", config };
}

/** Splits optional YAML frontmatter (between leading `---` lines) from the markdown body. */
export function splitFrontmatter(content: string): { data: unknown; body: string } {
  const text = content.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { data: undefined, body: text };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) throw new ConfigError("frontmatter: missing closing --- line");
  const yaml = lines.slice(1, end).join("\n");
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch (err) {
    throw new ConfigError(`frontmatter: invalid YAML: ${(err as Error).message}`);
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

async function readInstructions(file: string): Promise<{ frontmatter: FileConfig; task: string }> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    throw new ConfigError(`instructions file not found or unreadable: ${file}`);
  }
  const { data, body } = splitFrontmatter(content);
  if (data !== undefined && data !== null && (typeof data !== "object" || Array.isArray(data))) {
    throw new ConfigError("frontmatter: must be a YAML mapping");
  }
  const frontmatter = parseFileConfig(data, "frontmatter");
  const task = body.trim();
  if (!task) throw new ConfigError(`instructions file has an empty body: ${file}`);
  return { frontmatter, task };
}

async function readSettings(file: string): Promise<FileConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new ConfigError(`--settings: cannot read ${file}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`--settings: invalid JSON in ${file}: ${(err as Error).message}`);
  }
  return resolvePaths(parseFileConfig(data, `settings ${file}`), path.dirname(file));
}

function resolvePaths(cfg: FileConfig, dir: string): FileConfig {
  const r = (p: string | undefined) => (p === undefined ? undefined : path.resolve(dir, p));
  const out: FileConfig = { ...cfg };
  if (cfg.permissions?.root !== undefined) {
    out.permissions = { ...cfg.permissions, root: r(cfg.permissions.root) };
  }
  if (cfg.output !== undefined) out.output = r(cfg.output);
  if (cfg.logFile !== undefined) out.logFile = r(cfg.logFile);
  return out;
}

/** Tool entries from one config source, each with the directory its paths resolve against. */
function toolSpecs(
  tools: FileConfig["tools"],
  baseDir: string,
): { use: string; env: Record<string, string>; baseDir: string }[] {
  return (tools ?? []).map((t) =>
    typeof t === "string"
      ? { use: t, env: {}, baseDir }
      : { use: t.use, env: t.env ?? {}, baseDir },
  );
}

async function resolveTools(
  specs: { use: string; env: Record<string, string>; baseDir: string }[],
): Promise<ToolSource[]> {
  const out: ToolSource[] = [];
  for (const s of specs) {
    const dir = await resolveToolDir(s.use, s.baseDir);
    // The same tool listed twice (say in settings and with --tool) is loaded once.
    if (dir && out.some((t) => t.dir === dir)) continue;
    out.push({ use: s.use, env: s.env, ...(dir ? { dir } : {}) });
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function union(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

async function assertDir(dir: string, field: string): Promise<void> {
  const s = await stat(dir).catch(() => undefined);
  if (!s?.isDirectory()) throw new ConfigError(`${field}: not a directory: ${dir}`);
}
