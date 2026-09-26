import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { LogEvent, Permissions, ToolContext } from "../../src/core/types.js";
import { DEFAULT_PROTECTED_PATHS } from "../../src/permissions/index.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "twigg-tools-")));
  dirs.push(dir);
  return dir;
}

export function perms(overrides: Partial<Permissions["fs"]> & Partial<Permissions> = {}) {
  const { root = "/", read = true, write = true, delete: del = true, ...rest } = overrides;
  return {
    fs: { root, read, write, delete: del },
    network: true,
    bash: true,
    disabledTools: [],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
    ...rest,
  } satisfies Permissions;
}

export function makeCtx(
  cwd: string,
  opts: {
    permissions?: Permissions;
    timeoutMs?: number;
    signal?: AbortSignal;
    agentId?: string;
  } = {},
): ToolContext & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  return {
    permissions: opts.permissions ?? perms({ root: cwd }),
    cwd,
    signal: opts.signal ?? new AbortController().signal,
    timeoutMs: opts.timeoutMs ?? 10_000,
    agentId: opts.agentId ?? "main",
    logger: { log: (e) => events.push(e), close: async () => {} },
    events,
  };
}
