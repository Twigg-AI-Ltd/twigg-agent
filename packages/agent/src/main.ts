import { runMain } from "./agent/run.js";
import { createTwiggClient } from "./api/client.js";
import { resolveApiKey } from "./apikey.js";
import { parseFlags } from "./config/flags.js";
import { ConfigError, loadConfig } from "./config/index.js";
import { TwiggError } from "./core/client.js";
import { EXIT_CODES, type RunResult, type ToolSource } from "./core/types.js";
import { createLogger } from "./log/index.js";
import { formatModels } from "./models.js";
import { writeResult } from "./result.js";
import { loadCustomTools } from "./tools/custom.js";

/** Runs the CLI and returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  // Without a key nothing else can work, so it is the first thing reported. Help, the version and
  // the tools list don't need one.
  const found = await resolveApiKey(process.env, process.cwd());
  if (!found && needsApiKey(argv)) {
    process.stderr.write(NO_API_KEY);
    return EXIT_CODES.error;
  }

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
  // Runs and the models list only get here with a key: needsApiKey is true for both.
  const apiKey = found?.key ?? "";
  if (loaded.kind === "models") return listModels(apiKey);
  if (loaded.kind !== "run") {
    process.stdout.write(`${loaded.text}\n`);
    return 0;
  }
  const { config } = loaded;

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

const NO_API_KEY = `twigg-agent: no Twigg API key found. Set TWIGG_API_KEY in the environment, or put it
in a .env file in this folder:

  export TWIGG_API_KEY=tw_live_...

Create a key at https://twigg.ai.
`;

/** Whether the command line asks for something that calls the Twigg API. */
function needsApiKey(argv: string[]): boolean {
  try {
    const { kind } = parseFlags(argv);
    return kind === "run" || kind === "models";
  } catch {
    // A usage error; the missing key is still the first thing to fix.
    return true;
  }
}

/** The `models` command: the models the API key may use, with their rates. */
async function listModels(apiKey: string): Promise<number> {
  try {
    process.stdout.write(formatModels(await createTwiggClient({ apiKey }).listModels()));
    return 0;
  } catch (e) {
    const rejected = e instanceof TwiggError && (e.status === 401 || e.status === 403);
    process.stderr.write(
      rejected
        ? "twigg-agent: Twigg rejected the API key in TWIGG_API_KEY. Check it, or create a new one at https://twigg.ai.\n"
        : `twigg-agent: could not list the models: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return EXIT_CODES.error;
  }
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
