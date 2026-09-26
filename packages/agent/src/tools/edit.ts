import { readFile, stat, writeFile } from "node:fs/promises";
import * as s from "../core/schema.js";
import { checkPath } from "../permissions/index.js";
import { defineTool, fail, lastRead, ok, recordRead } from "./util.js";

export const editTool = defineTool({
  name: "edit",
  description:
    "Replace an exact string in a file. old_string must match exactly (including whitespace) " +
    "and be unique in the file unless replace_all is true. The file must have been read with " +
    "read first, and not changed since.",
  schema: s.object({
    path: s.string().describe("File path, absolute or relative to the working directory."),
    old_string: s.string({ min: 1 }).describe("Exact text to replace."),
    new_string: s.string().describe("Replacement text."),
    replace_all: s.boolean().optional().describe("Replace every occurrence (default false)."),
  }),
  async run(input, ctx) {
    const check = await checkPath(ctx, input.path, "write");
    if (!check.ok) return check.output;
    const path = check.path;
    const seen = lastRead(ctx.agentId, path);
    if (!seen) return fail(`Read ${input.path} with the read tool before editing it.`);
    const st = await stat(path);
    if (st.mtimeMs !== seen.mtimeMs || st.size !== seen.size) {
      return fail(`${input.path} changed on disk since you last read it. Read it again first.`);
    }
    if (input.old_string === input.new_string) {
      return fail("old_string and new_string are identical.");
    }

    const content = await readFile(path, "utf8");
    const count = content.split(input.old_string).length - 1;
    if (count === 0) return fail(`old_string was not found in ${input.path}.`);
    if (count > 1 && !input.replace_all) {
      return fail(
        `old_string occurs ${count} times in ${input.path}. Add surrounding context to make it ` +
          "unique, or set replace_all to true.",
      );
    }
    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, () => input.new_string);
    await writeFile(path, updated);
    recordRead(ctx.agentId, path, await stat(path));
    return ok(`Edited ${input.path} (${input.replace_all ? count : 1} replacement(s)).`);
  },
});
