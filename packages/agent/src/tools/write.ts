import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as s from "../core/schema.js";
import { checkPath } from "../permissions/index.js";
import { defineTool, ok, recordRead } from "./util.js";

export const writeTool = defineTool({
  name: "write",
  description:
    "Write a file, replacing it if it exists. Creates parent directories as needed. " +
    "Prefer edit for changing part of an existing file.",
  schema: s.object({
    path: s.string().describe("File path, absolute or relative to the working directory."),
    content: s.string().describe("Full file content."),
  }),
  async run(input, ctx) {
    const check = await checkPath(ctx, input.path, "write");
    if (!check.ok) return check.output;
    await mkdir(dirname(check.path), { recursive: true });
    await writeFile(check.path, input.content);
    recordRead(ctx.agentId, check.path, await stat(check.path));
    return ok(`Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}.`);
  },
});
