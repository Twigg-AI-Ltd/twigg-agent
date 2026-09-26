// Helpers shared by the built-in tools.

import { relative } from "node:path";
import { formatIssues, type Schema } from "../core/schema.js";
import type { JsonSchemaObject, Tool, ToolContext, ToolOutput } from "../core/types.js";

export function ok(text: string): ToolOutput {
  return { text, isError: false };
}

export function fail(text: string): ToolOutput {
  return { text, isError: true };
}

/** Builds a Tool whose input is validated by `schema`; `run` errors become isError results. */
export function defineTool<T extends object>(spec: {
  name: string;
  description: string;
  schema: Schema<T>;
  run(input: T, ctx: ToolContext): Promise<ToolOutput>;
}): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.schema.json as JsonSchemaObject,
    async run(input, ctx) {
      const parsed = spec.schema.parse(input);
      if (!parsed.ok) {
        return fail(`Invalid input for ${spec.name}:\n${formatIssues(parsed.issues)}`);
      }
      try {
        return await spec.run(parsed.value, ctx);
      } catch (err) {
        return fail(`${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** Path relative to cwd when below it, otherwise absolute. */
export function displayPath(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.cwd, abs);
  return rel === "" ? "." : rel.startsWith("..") ? abs : rel;
}

/** Truncates to `max` chars keeping head and tail around a marker. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - 2 * half;
  return `${text.slice(0, half)}\n\n[... ${dropped} characters truncated ...]\n\n${text.slice(-half)}`;
}

/** Last-seen mtime and size of files per agent, for edit's staleness check. */
const readState = new Map<string, Map<string, { mtimeMs: number; size: number }>>();

export function recordRead(agentId: string, path: string, st: { mtimeMs: number; size: number }) {
  const files = readState.get(agentId) ?? new Map();
  readState.set(agentId, files);
  files.set(path, { mtimeMs: st.mtimeMs, size: st.size });
}

export function lastRead(agentId: string, path: string) {
  return readState.get(agentId)?.get(path);
}

export const IGNORED_DIRS = ["**/node_modules/**", "**/.git/**"];
