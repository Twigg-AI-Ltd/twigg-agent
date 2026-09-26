import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import picomatch from "picomatch";
import * as s from "../core/schema.js";
import { checkPath, isProtected } from "../permissions/index.js";
import { defineTool, displayPath, fail, IGNORED_DIRS, ok } from "./util.js";

const MAX_RESULTS = 500;

/** Rejects patterns that could reach outside the search directory. */
export function unsafePattern(pattern: string): boolean {
  return isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..");
}

/** The leading folders of a pattern that hold no wildcard: the only place its matches can be. */
function fixedPrefix(pattern: string): string[] {
  const segments = pattern.split("/").slice(0, -1);
  const end = segments.findIndex((s) => s === "" || s === "." || /[*?[\]{}()!+@\\]/.test(s));
  return end === -1 ? segments : segments.slice(0, end);
}

/** Lists files under `base` matching `pattern`, sorted, never following symlinked directories. */
export async function listFiles(base: string, glob: string): Promise<string[]> {
  // A folder stands for everything in it.
  let pattern = glob.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const named = await lstat(join(base, pattern)).catch(() => undefined);
  if (named?.isDirectory()) pattern += "/**";
  const matches = picomatch(pattern, { dot: true });
  const prefix = fixedPrefix(pattern);
  // Without "**" a pattern can't match deeper than it has segments.
  const maxDepth = pattern.includes("**") ? Number.POSITIVE_INFINITY : pattern.split("/").length;
  const files: string[] = [];

  async function walk(dir: string, relative: string, depth: number): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable or gone: nothing to list.
      return;
    }
    const folders: Promise<void>[] = [];
    for (const entry of entries) {
      const rel = relative + entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.includes(entry.name) || depth >= maxDepth) continue;
        folders.push(walk(join(dir, entry.name), `${rel}/`, depth + 1));
      } else if (entry.isFile() && matches(rel)) {
        files.push(join(dir, entry.name));
      }
    }
    await Promise.all(folders);
  }

  if (prefix.some((name) => IGNORED_DIRS.includes(name))) return [];
  const start = join(base, ...prefix);
  // The prefix is followed only through real folders, as the rest of the walk is.
  for (let i = 1; i <= prefix.length; i++) {
    const st = await lstat(join(base, ...prefix.slice(0, i))).catch(() => undefined);
    if (!st?.isDirectory()) return [];
  }
  await walk(start, prefix.map((name) => `${name}/`).join(""), prefix.length + 1);
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
