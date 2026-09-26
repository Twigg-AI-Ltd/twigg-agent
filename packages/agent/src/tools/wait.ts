import * as s from "../core/schema.js";
import { formatDuration } from "../log/index.js";
import { defineTool, ok } from "./util.js";

/** Time kept back from the run's limit so the agent can still wrap up after waiting. */
export const WAIT_MARGIN_MS = 2 * 60_000;

export const waitTool = defineTool({
  name: "wait",
  description:
    "Pause for a number of minutes, then continue. Use it to give people time to reply or a job " +
    "time to finish before checking again. Nothing happens and nothing is spent while waiting, " +
    "but the wait counts toward the run's time limit: if the run would end first, the wait is " +
    "shortened and you are told to wrap up.",
  schema: s.object({
    minutes: s.number({ gt: 0, max: 24 * 60 }).describe("How long to wait, e.g. 10 or 0.5."),
    reason: s
      .string({ max: 200 })
      .optional()
      .describe("What you are waiting for (shown in the log)."),
  }),
  async run(input, ctx) {
    const wanted = input.minutes * 60_000;
    const available = Math.max(0, (ctx.runRemainingMs ?? wanted + WAIT_MARGIN_MS) - WAIT_MARGIN_MS);
    const ms = Math.min(wanted, available);
    const started = Date.now();
    const interrupted = await sleep(ms, ctx.signal);
    const waited = formatDuration(Date.now() - started);
    if (interrupted)
      return { text: `Wait interrupted after ${waited}: the run is stopping.`, isError: true };
    if (ms < wanted) {
      return ok(
        `Waited ${waited} instead of ${formatDuration(wanted)}: the run's time limit is close. ` +
          "Wrap up now and call finish.",
      );
    }
    return ok(`Waited ${waited}. Continue.`);
  },
});

/** Resolves true if the signal aborted the wait. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
