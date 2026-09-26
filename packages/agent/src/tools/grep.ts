import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { checkPath, isProtected } from "../permissions/index.js";
import { listFiles, unsafePattern } from "./glob.js";
import { defineTool, displayPath, fail, ok } from "./util.js";

const MAX_MATCHES = 200;
const MAX_LINE = 300;
const MAX_FILE_BYTES = 10_000_000;

export const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression. Returns matching lines as " +
    `file:line: text (up to ${MAX_MATCHES}). Skips binary files, node_modules and .git.`,
  schema: z.object({
    pattern: z.string().min(1).describe("JavaScript regular expression (no slashes or flags)."),
    path: z.string().optional().describe("File or directory to search (default: working dir)."),
    glob: z
      .string()
      .optional()
      .describe('Only search files matching this glob, e.g. "*.ts" or "src/**/*.js".'),
    ignore_case: z.boolean().optional().describe("Case-insensitive match (default false)."),
  }),
  async run(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignore_case ? "i" : "");
    } catch (err) {
      return fail(`Invalid regular expression: ${(err as Error).message}`);
    }
    const check = await checkPath(ctx, input.path ?? ".", "read");
    if (!check.ok) return check.output;

    let files: string[];
    if ((await lstat(check.path)).isDirectory()) {
      let pattern = input.glob ?? "**/*";
      if (unsafePattern(pattern)) return fail("glob must be relative and must not contain '..'.");
      if (!pattern.includes("/")) pattern = `**/${pattern}`;
      files = (await listFiles(check.path, pattern)).filter(
        (f) => !isProtected(ctx.permissions, f),
      );
    } else {
      files = [check.path];
    }

    const out: string[] = [];
    let total = 0;
    for (const file of files) {
      const st = await lstat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const buf = await readFile(file);
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!re.test(line)) continue;
        total++;
        if (out.length < MAX_MATCHES) {
          const text = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line;
          out.push(`${displayPath(ctx, file)}:${i + 1}: ${text}`);
        }
      }
    }
    if (total === 0) return ok("No matches.");
    if (total > MAX_MATCHES) {
      out.push(`[${total - MAX_MATCHES} more matches not shown; narrow the pattern or path.]`);
    }
    return ok(out.join("\n"));
  },
});
