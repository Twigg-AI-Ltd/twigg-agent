import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import type { LogEvent, Logger } from "../core/types.js";
import { formatHuman } from "./format.js";

export { formatDuration, formatHuman, type HumanOptions } from "./format.js";

export interface LoggerOptions {
  format: "human" | "json";
  /** Also append every event as JSON to this file. */
  file?: string;
  /** Console sink; defaults to process.stderr. */
  stream?: NodeJS.WritableStream;
  /** Colour the human format; defaults to on for a TTY unless NO_COLOR is set (FORCE_COLOR forces it). */
  color?: boolean;
}

export function createLogger(opts: LoggerOptions): Logger {
  const stream = opts.stream ?? process.stderr;
  const tty = (stream as { isTTY?: boolean }).isTTY === true;
  const color = opts.color ?? useColor(tty, process.env);
  let file: NodeJS.WritableStream | undefined;
  if (opts.file) {
    mkdirSync(path.dirname(opts.file), { recursive: true });
    file = createWriteStream(opts.file, { flags: "a" });
  }
  return {
    log(event) {
      const now = new Date();
      const json = toJson(event, now);
      const width = tty ? (stream as { columns?: number }).columns : undefined;
      const text = opts.format === "json" ? json : formatHuman(event, now, { color, width });
      if (text) stream.write(`${text}\n`);
      file?.write(`${json}\n`);
    },
    close() {
      const f = file;
      file = undefined;
      if (!f) return Promise.resolve();
      return new Promise((resolve, reject) => {
        f.once("error", reject);
        f.end(() => resolve());
      });
    },
  };
}

/** https://no-color.org and the FORCE_COLOR convention. */
export function useColor(tty: boolean, env: NodeJS.ProcessEnv): boolean {
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (env.NO_COLOR) return false;
  return tty && env.TERM !== "dumb";
}

function toJson(event: LogEvent, now: Date): string {
  return JSON.stringify({ ts: now.toISOString(), ...event });
}
