import * as s from "../core/schema.js";
import { defineTool, ok } from "./util.js";

export const todoTool = defineTool({
  name: "todo",
  description:
    "Replace your task checklist with the given items. Use it to plan multi-step work and " +
    "mark items done as you go. Send the full list each time.",
  schema: s.object({
    items: s
      .array(s.object({ text: s.string({ min: 1 }), done: s.boolean() }))
      .describe("The complete checklist."),
  }),
  async run(input, ctx) {
    ctx.logger.log({ type: "todo", agentId: ctx.agentId, items: input.items });
    const done = input.items.filter((i) => i.done).length;
    return ok(`Checklist updated: ${done}/${input.items.length} done.`);
  },
});
