import { readFile, stat } from "node:fs/promises";
import * as s from "../core/schema.js";
import { checkPath } from "../permissions/index.js";
import { defineTool, fail, ok, recordRead } from "./util.js";

const DEFAULT_LIMIT = 2000;
const MAX_CHARS = 100_000;

export const readTool = defineTool({
  name: "read",
  description:
    "Read a text file. Returns lines prefixed with their 1-based line number. " +
    `Reads up to ${DEFAULT_LIMIT} lines by default; use offset/limit to page through large files. ` +
    "A file must be read before it can be edited.",
  schema: s.object({
    path: s.string().describe("File path, absolute or relative to the working directory."),
    offset: s
      .number({ int: true, min: 1 })
      .optional()
      .describe("1-based line to start at (default 1)."),
    limit: s
      .number({ int: true, min: 1 })
      .optional()
      .describe(`Max lines (default ${DEFAULT_LIMIT}).`),
  }),
  async run(input, ctx) {
    const check = await checkPath(ctx, input.path, "read");
    if (!check.ok) return check.output;
    const st = await stat(check.path);
    if (st.isDirectory()) return fail(`${input.path} is a directory; use glob to list files.`);
    const buf = await readFile(check.path);
    recordRead(ctx.agentId, check.path, st);
    if (buf.subarray(0, 8000).includes(0)) return fail(`${input.path} looks like a binary file.`);
    if (buf.length === 0) return ok("(empty file)");

    const lines = buf.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const start = (input.offset ?? 1) - 1;
    if (start >= lines.length) {
      return fail(`offset ${input.offset} is past the end of the file (${lines.length} lines).`);
    }
    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_LIMIT));
    let out = "";
    let shown = start;
    for (; shown < end; shown++) {
      const line = `${String(shown + 1).padStart(6)}\t${lines[shown]}\n`;
      if (out.length + line.length > MAX_CHARS) break;
      out += line;
    }
    if (shown < lines.length) {
      out += `\n[Showing lines ${start + 1}-${shown} of ${lines.length}. Use offset=${shown + 1} to read more.]`;
    }
    return ok(out);
  },
});
