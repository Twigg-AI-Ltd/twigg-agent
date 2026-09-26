import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXIT_CODES, type RunResult, type RunStatus } from "./core/types.js";

/** Writes the result as pretty JSON, creating parent directories. */
export async function writeResult(file: string, result: RunResult): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
}

export function exitCodeFor(status: RunStatus): number {
  return EXIT_CODES[status];
}
