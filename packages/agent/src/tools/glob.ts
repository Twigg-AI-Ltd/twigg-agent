import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { glob } from "tinyglobby";
import * as s from "../core/schema.js";
import { checkPath, isProtected } from "../permissions/index.js";
import { defineTool, displayPath, fail, IGNORED_DIRS, ok } from "./util.js";

const MAX_RESULTS = 500;

/** Rejects patterns that could reach outside the search directory. */
export function unsafePattern(pattern: string): boolean {
  return isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..");
}

/** Lists files under `base` matching `pattern`, sorted, never following symlinked directories. */
export async function listFiles(base: string, pattern: string): Promise<string[]> {
  const files = await glob(pattern, {
    cwd: base,
    absolute: true,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: IGNORED_DIRS,
  });
  return files.sort();
}

export const globTool = defineTool({
  name: "glob",
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/**/index.{js,ts}"). ' +
    `Ignores node_modules and .git. Returns up to ${MAX_RESULTS} paths, sorted.`,
  schema: s.object({
    pattern: s.string({ min: 1 }).describe("Glob pattern, relative to path."),
    path: s.string().optional().describe("Directory to search (default: working directory)."),
  }),
  async run(input, ctx) {
    if (unsafePattern(input.pattern)) {
      return fail("pattern must be relative and must not contain '..'; set path instead.");
    }
    const check = await checkPath(ctx, input.path ?? ".", "read");
    if (!check.ok) return check.output;
    if (!(await stat(check.path)).isDirectory()) return fail(`${input.path} is not a directory.`);
    const files = (await listFiles(check.path, input.pattern)).filter(
      (f) => !isProtected(ctx.permissions, f),
    );
    if (files.length === 0) return ok("No files matched.");
    const lines = files.slice(0, MAX_RESULTS).map((f) => displayPath(ctx, f));
    if (files.length > MAX_RESULTS) {
      lines.push(`[${files.length - MAX_RESULTS} more not shown; use a narrower pattern.]`);
    }
    return ok(lines.join("\n"));
  },
});
