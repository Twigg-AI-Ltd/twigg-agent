import { lstat, rm } from "node:fs/promises";
import { z } from "zod";
import { checkPath } from "../permissions/index.js";
import { defineTool, fail, ok } from "./util.js";

export const deleteTool = defineTool({
  name: "delete",
  description:
    "Delete a file or symlink. Deleting a directory requires recursive: true and removes " +
    "everything in it.",
  schema: z.object({
    path: z.string().describe("Path, absolute or relative to the working directory."),
    recursive: z.boolean().optional().describe("Required to delete a directory."),
  }),
  async run(input, ctx) {
    const check = await checkPath(ctx, input.path, "delete");
    if (!check.ok) return check.output;
    const st = await lstat(check.path).catch(() => undefined);
    if (!st) return fail(`${input.path} does not exist.`);
    if (st.isDirectory() && !input.recursive) {
      return fail(`${input.path} is a directory; set recursive: true to delete it.`);
    }
    await rm(check.path, { recursive: st.isDirectory() });
    return ok(`Deleted ${input.path}.`);
  },
});
