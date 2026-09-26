// Permission checks shared by the built-in tools.

import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import type { Permissions, ToolContext, ToolOutput } from "../core/types.js";

export type FsNeed = "read" | "write" | "delete";

export type PathCheck = { ok: true; path: string } | { ok: false; output: ToolOutput };

/** The standard result for an action a permission blocked. `action` completes "I tried to …". */
export function blockedOutput(action: string): ToolOutput {
  return {
    isError: true,
    blocked: true,
    text:
      `BLOCKED: the user has blocked this action (${action}). ` +
      "Do not look for a workaround or try to achieve the same result another way. " +
      'Call `finish` with status "failed" and explain: ' +
      `"I tried to ${action} but it was blocked."`,
  };
}

/**
 * There is no sandbox, so `bash` could bypass every other rule. It is offered only when the user
 * enabled it and nothing else is switched off: with read, write, delete or network off (or bash
 * disabled by name) it stays off. The root confinement applies to file tools only.
 */
export function bashAvailable(perms: Permissions): boolean {
  const { fs } = perms;
  return (
    perms.bash &&
    fs.read &&
    fs.write &&
    fs.delete &&
    perms.network &&
    !perms.disabledTools.includes("bash")
  );
}

/** Why bash is off for these permissions, for the log and the agent; undefined when it is on. */
export function bashDisabledReason(perms: Permissions): string | undefined {
  if (perms.disabledTools.includes("bash") || bashAvailable(perms)) return undefined;
  if (!perms.bash) {
    return "it is off by default because it runs without a sandbox; enable it with --allow-bash";
  }
  const off = [
    !perms.fs.read && "read",
    !perms.fs.write && "write",
    !perms.fs.delete && "delete",
    !perms.network && "network",
  ].filter(Boolean);
  return `${off.join(", ")} ${off.length > 1 ? "are" : "is"} switched off, and bash runs without a sandbox, so it could get around that`;
}

/** Files that hold secrets. Always protected; users can add patterns but not remove these. */
export const DEFAULT_PROTECTED_PATHS = [
  ".env",
  ".env.*",
  "*.env",
  ".envrc",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".ssh/**",
  ".aws/**",
  ".gnupg/**",
  ".kube/config",
  ".docker/config.json",
  ".config/gcloud/**",
  ".config/agent-box/**",
];

/** Common non-secret files the defaults would otherwise catch. */
const PROTECTED_EXCEPTIONS = picomatch([".env.example", ".env.sample", ".env.template", "*.pub"], {
  dot: true,
});

const matcherCache = new Map<string, (path: string) => boolean>();

/** Matcher over absolute paths for a list of protected patterns. */
export function protectedMatcher(patterns: string[]): (absPath: string) => boolean {
  const key = patterns.join("\0");
  let m = matcherCache.get(key);
  if (!m) {
    const byName = picomatch(
      patterns.filter((p) => !p.includes("/")),
      { dot: true },
    );
    const bySuffix = picomatch(
      patterns.filter((p) => p.includes("/")).map((p) => `**/${p.replace(/^\/+/, "")}`),
      { dot: true },
    );
    m = (absPath: string) => {
      const name = basename(absPath);
      if (PROTECTED_EXCEPTIONS(name)) return false;
      return byName(name) || bySuffix(absPath.replace(/^\/+/, ""));
    };
    matcherCache.set(key, m);
  }
  return m;
}

export function isProtected(perms: Permissions, absPath: string): boolean {
  return protectedMatcher(perms.protectedPaths)(absPath);
}

/**
 * Basic guard for `bash`: the protected pattern a command appears to reference, if any. Checks
 * each word of the command as a path relative to `cwd`. Best effort, not a security boundary.
 */
export function protectedReference(
  perms: Permissions,
  cwd: string,
  command: string,
): string | undefined {
  const matches = protectedMatcher(perms.protectedPaths);
  for (const word of command.split(/[\s;&|<>()'"`=,]+/)) {
    if (!word || word.startsWith("-")) continue;
    const abs = resolve(cwd, word.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    if (matches(abs)) return word;
  }
  return undefined;
}

/** True when `path` equals `root` or lies below it. Both must be absolute and normalised. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** realpath of `path`, or of its nearest existing ancestor with the missing tail re-appended. */
async function realpathLoose(path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) throw err;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves `path` (relative to `ctx.cwd`) and checks it against the permissions. Returns the
 * absolute (non-symlink-resolved) path to operate on, or a blocked output.
 */
export async function checkPath(ctx: ToolContext, path: string, need: FsNeed): Promise<PathCheck> {
  const fs = ctx.permissions.fs;
  const abs = resolve(ctx.cwd, path);
  const verb = need === "read" ? "read" : need === "write" ? "write to" : "delete";
  if (!fs[need]) return { ok: false, output: blockedOutput(`${verb} ${abs}`) };

  const root = await realpathLoose(resolve(fs.root));
  // Deleting a symlink removes the link itself, so only its parent directory must be inside.
  const real =
    need === "delete"
      ? join(await realpathLoose(dirname(abs)), basename(abs))
      : await realpathLoose(abs);
  if (isProtected(ctx.permissions, abs) || isProtected(ctx.permissions, real)) {
    return {
      ok: false,
      output: blockedOutput(`${verb} ${abs}, which is a protected file (it may hold secrets)`),
    };
  }
  if (!isInside(root, real)) {
    return {
      ok: false,
      output: blockedOutput(`${verb} ${abs}, which is outside the allowed directory ${fs.root}`),
    };
  }
  return { ok: true, path: abs };
}
