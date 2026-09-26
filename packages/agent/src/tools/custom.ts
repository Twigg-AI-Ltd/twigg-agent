// Custom tools: folders with a tool.json manifest and a command, listed in settings (`tools`) or
// with `--tool`. A folder can come from an npm package or a local path. The harness runs the
// command itself (never through bash), with only the environment the tool asked for.

import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import * as s from "../core/schema.js";
import type { JsonSchemaObject, Permissions, Tool, ToolOutput, ToolSource } from "../core/types.js";
import { blockedOutput } from "../permissions/index.js";
import { fail, ok, truncateMiddle } from "./util.js";

const MAX_CHARS = 30_000;

/** Exit code a tool uses to say a policy of its own (such as an allow list) refused the call. */
export const BLOCKED_EXIT_CODE = 3;

/** Folder under the agent's working directory where tools keep state between runs. */
export const STATE_DIR = ".twigg-agent";

/** Names the harness uses itself. */
const RESERVED = new Set([
  "read",
  "glob",
  "grep",
  "write",
  "edit",
  "delete",
  "web_fetch",
  "bash",
  "todo",
  "wait",
  "finish",
  "subagent",
]);

/** Variables every tool gets from the harness environment, whether it declares them or not. */
const BASE_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR", "SYSTEMROOT"];

export const TOOL_PERMISSIONS = ["read", "write", "delete", "network"] as const;
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];

const text = s.string({ min: 1 });

const ManifestSchema = s.object(
  {
    name: s.string({ pattern: /^[a-zA-Z0-9_-]{1,64}$/ }),
    description: text,
    input_schema: s.object({ type: s.oneOf(["object"]) }, "keep"),
    /** Program and arguments, run in the tool's folder. `node` means the harness's own Node. */
    command: s.array(text, { min: 1 }),
    /** Environment variables the tool needs; it can't be used until all are set. */
    env: s.array(text).optional(),
    /** What the tool does; it is left out of runs (and subagents) where any of these is denied. */
    permissions: s.array(s.oneOf(TOOL_PERMISSIONS)).optional(),
    /** Shorthand for `"permissions": ["network"]`. */
    network: s.boolean().optional(),
    /** How far Twigg should trust the output; use "untrusted" for outside content such as email. */
    trust: s.oneOf(["trusted", "customer_data", "untrusted"]).optional(),
    /** The folder has a package.json whose dependencies must be installed (`npm install`). */
    needs_npm_install: s.boolean().optional(),
  },
  "strict",
);

/** tool.json holds one manifest, or an array of them sharing the folder's code and state. */
const ManifestFileSchema = s.union(ManifestSchema, s.array(ManifestSchema, { min: 1 }));

export type Manifest = s.Infer<typeof ManifestSchema>;

export interface CustomTool extends Tool {
  dir: string;
  permissions: ToolPermission[];
}

/** One tool from a source: usable, or why it cannot be used. */
export type CustomToolEntry =
  | { source: string; dir?: string; name: string; tool: CustomTool }
  | { source: string; dir?: string; name: string; problem: string };

/** True when `use` names a folder rather than an npm package. */
export function isPathSource(use: string): boolean {
  return use.startsWith(".") || use.startsWith("~") || isAbsolute(use);
}

/** Where the harness itself is installed; packages installed next to it are found too. */
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The folder holding a tool source's tool.json. A path resolves against `baseDir`; a package is
 * looked up in node_modules above `baseDir`, then above the harness's own install (so global and
 * npx installs of both work). Undefined when not found.
 */
export async function resolveToolDir(
  use: string,
  baseDir: string,
  home: string | undefined = process.env.HOME,
): Promise<string | undefined> {
  if (isPathSource(use)) {
    const p = use.startsWith("~") && home ? join(home, use.slice(1)) : use;
    return resolve(baseDir, p);
  }
  for (const start of [baseDir, HARNESS_DIR]) {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", use);
      if (await isFile(join(candidate, "tool.json"))) return candidate;
      if (dirname(dir) === dir) break;
    }
  }
  return undefined;
}

/**
 * Loads each source's tools. A tool name used by an earlier source makes the later one a problem,
 * as does a source that is missing or broken.
 */
export async function loadCustomTools(
  sources: ToolSource[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CustomToolEntry[]> {
  const entries: CustomToolEntry[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const entry of await loadSource(source, env)) {
      if ("tool" in entry && seen.has(entry.name)) {
        const { tool: _, ...rest } = entry;
        entries.push({ ...rest, problem: `another tool is already named "${entry.name}"` });
        continue;
      }
      seen.add(entry.name);
      entries.push(entry);
    }
  }
  return entries;
}

async function loadSource(source: ToolSource, env: NodeJS.ProcessEnv): Promise<CustomToolEntry[]> {
  const { use, dir } = source;
  const bad = (problem: string): CustomToolEntry[] => [{ source: use, dir, name: use, problem }];
  if (!dir) return bad(`not installed (run \`npm install ${use}\`)`);
  let raw: string;
  try {
    raw = await readFile(join(dir, "tool.json"), "utf8");
  } catch {
    return bad(`no tool.json in ${dir}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return bad(`tool.json: invalid JSON: ${(e as Error).message}`);
  }
  const parsed = ManifestFileSchema.parse(data);
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    return bad(`tool.json: ${issue?.path || "(root)"}: ${issue?.message ?? "invalid"}`);
  }
  const manifests = Array.isArray(parsed.value) ? parsed.value : [parsed.value];

  let dotenv: Record<string, string> = {};
  try {
    dotenv = parseEnv(await readFile(join(dir, ".env"), "utf8")) as Record<string, string>;
  } catch {
    // No .env: the variables may come from settings or the environment instead.
  }
  const installed = await stat(join(dir, "node_modules")).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const stateName = stateDirName(use, dir);

  return manifests.map((m): CustomToolEntry => {
    const problem = (text: string): CustomToolEntry => ({
      source: use,
      dir,
      name: m.name,
      problem: text,
    });
    if (RESERVED.has(m.name)) return problem(`"${m.name}" is the name of a built-in tool`);
    const toolEnv = toolEnvironment(m.env ?? [], env, dotenv, source.env);
    const missing = (m.env ?? []).filter((k) => !toolEnv[k]?.trim());
    if (missing.length) {
      return problem(
        `missing ${missing.join(", ")} (set it in the environment or in the tool's "env" in settings)`,
      );
    }
    if (m.needs_npm_install && !installed) return problem(`run \`npm install\` in ${dir}`);
    return { source: use, dir, name: m.name, tool: makeTool(m, dir, toolEnv, stateName) };
  });
}

/**
 * What a tool's process sees: a few basics and the variables it declares from the harness
 * environment, then its folder's .env, then the values from settings. Nothing else, so the
 * harness's own secrets (such as TWIGG_API_KEY) stay out unless a tool asks for them.
 */
function toolEnvironment(
  declared: string[],
  env: NodeJS.ProcessEnv,
  dotenv: Record<string, string>,
  settings: Record<string, string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of [...BASE_ENV, ...declared]) if (env[k] !== undefined) out[k] = env[k];
  return { ...out, ...dotenv, ...settings };
}

/** `@twigg/agent-database` → `twigg__agent-database`; a folder → its name. */
function stateDirName(use: string, dir: string): string {
  return isPathSource(use) ? basename(dir) : use.replace(/^@/, "").replaceAll("/", "__");
}

/** Whether `perms` allow everything the tool declares. */
export function toolAllowed(tool: CustomTool, perms: Permissions): boolean {
  const allowed: Record<ToolPermission, boolean> = {
    read: perms.fs.read,
    write: perms.fs.write,
    delete: perms.fs.delete,
    network: perms.network,
  };
  return tool.permissions.every((p) => allowed[p]);
}

function makeTool(m: Manifest, dir: string, env: NodeJS.ProcessEnv, stateName: string): CustomTool {
  const declared: ToolPermission[] = [
    ...(m.permissions ?? []),
    ...(m.network ? ["network" as const] : []),
  ];
  return {
    name: m.name,
    description: m.description,
    inputSchema: m.input_schema as JsonSchemaObject,
    dir,
    permissions: [...new Set(declared)],
    async run(input, ctx): Promise<ToolOutput> {
      if (ctx.signal.aborted) return fail("Aborted before running.");
      const stateDir = join(ctx.cwd, STATE_DIR, "state", stateName);
      await mkdir(stateDir, { recursive: true });
      const [first, ...args] = m.command as [string, ...string[]];
      const child = spawn(first === "node" ? process.execPath : first, args, {
        cwd: dir,
        env: { ...env, TWIGG_AGENT_CWD: ctx.cwd, TWIGG_AGENT_STATE_DIR: stateDir },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => {
        if (stdout.length < 4 * MAX_CHARS) stdout += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        if (stderr.length < 4 * MAX_CHARS) stderr += c.toString("utf8");
      });
      // The tool may exit without reading its input.
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input ?? {}));

      let killedBy: string | undefined;
      const kill = (reason: string) => {
        killedBy ??= reason;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(() => kill(`timed out after ${ctx.timeoutMs} ms`), ctx.timeoutMs);
      const onAbort = () => kill("aborted");
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const code = await new Promise<number | null>((resolve) => {
        child.on("error", (err) => {
          stderr += `${err.message}\n`;
          resolve(null);
        });
        child.on("close", (exitCode) => resolve(exitCode));
      });
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);

      const out = truncateMiddle(stdout.trim(), MAX_CHARS);
      if (killedBy) return fail(`${m.name} was killed: ${killedBy}\n${out}`.trim());
      if (code === 0)
        return { ...ok(out || "(no output)"), ...(m.trust ? { trust: m.trust } : {}) };
      if (code === BLOCKED_EXIT_CODE) return blockedOutput(oneLineOf(out) || `use ${m.name}`);
      const err = truncateMiddle(stderr.trim(), MAX_CHARS);
      return fail([out, err, `[exit code: ${code ?? "unknown"}]`].filter(Boolean).join("\n"));
    },
  };
}

async function isFile(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
}

function oneLineOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}
