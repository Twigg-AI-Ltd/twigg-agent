import { runMain } from "./agent/run.js";
import { createTwiggClient } from "./api/client.js";
import { resolveApiKey } from "./apikey.js";
import { ConfigError, loadConfig } from "./config/index.js";
import { EXIT_CODES, type RunResult, type ToolSource } from "./core/types.js";
import { createLogger } from "./log/index.js";
import { writeResult } from "./result.js";
import { loadCustomTools } from "./tools/custom.js";

/** Runs the CLI and returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(argv);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`twigg-agent: ${e.message}\nRun twigg-agent --help for usage.\n`);
      return EXIT_CODES.error;
    }
    throw e;
  }
  if (loaded.kind === "tools") {
    process.stdout.write(await describeTools(loaded.tools));
    return 0;
  }
  if (loaded.kind !== "run") {
    process.stdout.write(`${loaded.text}\n`);
    return 0;
  }
  const { config } = loaded;

  const found = await resolveApiKey(process.env, process.cwd());
  if (!found) {
    process.stderr.write(
      "twigg-agent: TWIGG_API_KEY is not set (checked the environment and ./.env).\n",
    );
    return EXIT_CODES.error;
  }
  const apiKey = found.key;

  const logger = createLogger({
    format: config.logFormat,
    ...(config.logFile ? { file: config.logFile } : {}),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("time"), config.limits.timeoutMs);
  const onSigint = () => {
    // A second Ctrl-C exits immediately.
    if (controller.signal.aborted) process.exit(EXIT_CODES.interrupted);
    controller.abort("interrupted");
  };
  process.on("SIGINT", onSigint);

  let result: RunResult;
  try {
    result = await runMain(config, createTwiggClient({ apiKey }), logger, controller.signal);
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSigint);
  }

  logger.log({ type: "run_finish", result });
  if (config.outputPath) await writeResult(config.outputPath, result);
  await logger.close();
  return EXIT_CODES[result.status];
}

/** The `tools` command: each configured custom tool, where it lives and whether it is ready. */
async function describeTools(sources: ToolSource[]): Promise<string> {
  if (!sources.length) {
    return 'No custom tools configured. Add them with --tool <pkg|path> or "tools" in a settings file.\n';
  }
  const entries = await loadCustomTools(sources);
  const width = Math.max(...entries.map((e) => e.name.length));
  const blocks = sources.map((s) => {
    const lines = entries
      .filter((e) => e.source === s.use)
      .map((e) => {
        const status =
          "tool" in e
            ? `ready${e.tool.permissions.length ? ` (${e.tool.permissions.join(", ")})` : ""}`
            : e.problem;
        return `  ${"tool" in e ? "✔" : "✗"} ${e.name.padEnd(width)}  ${status}`;
      });
    return `${s.use}${s.dir && s.dir !== s.use ? `  (${s.dir})` : ""}\n${lines.join("\n")}`;
  });
  return `${blocks.join("\n\n")}\n`;
}
