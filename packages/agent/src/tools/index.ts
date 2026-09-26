// Built-in tool registry. `finish` and `subagent` are built by agent/, not here.

import type { ToolDefinition } from "../api/types.js";
import type { Permissions, Tool } from "../core/types.js";
import { bashAvailable } from "../permissions/index.js";
import { bashTool } from "./bash.js";
import { type CustomTool, toolAllowed } from "./custom.js";
import { deleteTool } from "./delete.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readTool } from "./read.js";
import { todoTool } from "./todo.js";
import { waitTool } from "./wait.js";
import { webFetchTool } from "./web-fetch.js";
import { writeTool } from "./write.js";

export {
  bashTool,
  deleteTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  todoTool,
  waitTool,
  webFetchTool,
  writeTool,
};

/**
 * The built-in tools the permissions allow, plus the custom tools whose declared permissions they
 * allow. Fully disabled capabilities are not offered.
 */
export function buildTools(perms: Permissions, custom: CustomTool[] = []): Tool[] {
  const { fs } = perms;
  const tools: Tool[] = [];
  if (fs.read) tools.push(readTool, globTool, grepTool);
  if (fs.write) tools.push(writeTool, editTool);
  if (fs.delete) tools.push(deleteTool);
  if (perms.network) tools.push(webFetchTool);
  if (bashAvailable(perms)) tools.push(bashTool);
  tools.push(todoTool, waitTool);
  tools.push(...custom.filter((t) => toolAllowed(t, perms)));
  return tools.filter((t) => !perms.disabledTools.includes(t.name));
}

/** Maps a Tool to Twigg's ToolDefinition shape. */
export function toolDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}
