import { spawn } from "node:child_process";
import * as s from "../core/schema.js";
import { blockedOutput, protectedReference } from "../permissions/index.js";
import { defineTool, truncateMiddle } from "./util.js";

const MAX_CHARS = 30_000;

export const bashTool = defineTool({
  name: "bash",
  description:
    "Run a shell command with bash -c in the working directory. Returns combined stdout and " +
    "stderr (long output is truncated in the middle) and the exit code. Non-interactive: no stdin.",
  schema: s.object({
    command: s.string({ min: 1 }).describe("The command to run."),
    timeout_ms: s
      .number({ int: true, min: 1 })
      .optional()
      .describe("Timeout (capped by the tool limit)."),
  }),
  async run(input, ctx) {
    const timeoutMs = Math.min(input.timeout_ms ?? ctx.timeoutMs, ctx.timeoutMs);
    if (ctx.signal.aborted) return { text: "Aborted before running.", isError: true };
    const hit = protectedReference(ctx.permissions, ctx.cwd, input.command);
    if (hit) return blockedOutput(`run a command that touches ${hit}, which is a protected file`);

    const child = spawn("bash", ["-c", input.command], {
      cwd: ctx.cwd,
      env: childEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let dropped = false;
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      // Bound memory for chatty commands: keep head and tail only.
      if (output.length > 4 * MAX_CHARS) {
        output = truncateMiddle(output, 2 * MAX_CHARS);
        dropped = true;
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let killedBy: string | undefined;
    const kill = (reason: string) => {
      killedBy ??= reason;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => kill(`timed out after ${timeoutMs} ms`), timeoutMs);
    const onAbort = () => kill("aborted");
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const code = await new Promise<number | null>((resolve) => {
      child.on("error", (err) => {
        output += `\n${err.message}`;
        resolve(null);
      });
      child.on("close", (exitCode) => resolve(exitCode));
    });
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);

    let text = truncateMiddle(output, MAX_CHARS);
    if (dropped && text === output) text = `[output truncated]\n${text}`;
    const status = killedBy ? `[killed: ${killedBy}]` : `[exit code: ${code ?? "unknown"}]`;
    text = text ? `${text.trimEnd()}\n${status}` : status;
    return { text, isError: killedBy !== undefined || code !== 0 };
  },
});

/** The harness's own environment minus its Twigg API key, which commands have no need for. */
function childEnv(): NodeJS.ProcessEnv {
  const { TWIGG_API_KEY: _, ...env } = process.env;
  return env;
}
