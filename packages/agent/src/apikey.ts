import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const API_KEY_VAR = "TWIGG_API_KEY";

/**
 * The Twigg API key: the environment variable if set, otherwise `TWIGG_API_KEY` from `.env` in
 * `dir`. Only that one key is read; nothing else from the file enters the process environment.
 */
export async function resolveApiKey(
  env: NodeJS.ProcessEnv,
  dir: string,
): Promise<{ key: string; source: "env" | ".env" } | undefined> {
  const fromEnv = env[API_KEY_VAR]?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  let content: string;
  try {
    content = await readFile(join(dir, ".env"), "utf8");
  } catch {
    return undefined;
  }
  const fromFile = (parseEnv(content) as Record<string, string | undefined>)[API_KEY_VAR]?.trim();
  return fromFile ? { key: fromFile, source: ".env" } : undefined;
}
