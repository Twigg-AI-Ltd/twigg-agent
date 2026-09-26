import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bashAvailable,
  bashDisabledReason,
  blockedOutput,
  checkPath,
  DEFAULT_PROTECTED_PATHS,
  protectedMatcher,
  protectedReference,
} from "../../src/permissions/index.js";
import { makeCtx, perms, tempDir } from "../tools/helpers.js";

describe("blockedOutput", () => {
  it("uses the standard wording", () => {
    const out = blockedOutput("write to /x/y");
    expect(out.isError).toBe(true);
    expect(out.blocked).toBe(true);
    expect(out.text).toContain("the user has blocked this action");
    expect(out.text).toContain("write to /x/y");
    expect(out.text).toContain("Do not look for a workaround");
    expect(out.text).toContain('status "failed"');
    expect(out.text).toContain('"I tried to write to /x/y but it was blocked."');
  });
});

describe("checkPath", () => {
  async function setup() {
    const base = await tempDir();
    const root = join(base, "root");
    await mkdir(root);
    await writeFile(join(base, "secret.txt"), "s");
    await writeFile(join(root, "a.txt"), "a");
    return { base, root, ctx: makeCtx(root, { permissions: perms({ root }) }) };
  }

  it("allows paths inside root, relative or absolute", async () => {
    const { root, ctx } = await setup();
    expect(await checkPath(ctx, "a.txt", "read")).toEqual({ ok: true, path: join(root, "a.txt") });
    expect((await checkPath(ctx, join(root, "new/deep/b.txt"), "write")).ok).toBe(true);
  });

  it("blocks .. escapes", async () => {
    const { ctx } = await setup();
    const res = await checkPath(ctx, "../secret.txt", "read");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.output.blocked).toBe(true);
      expect(res.output.text).toContain("outside the allowed directory");
    }
  });

  it("blocks absolute paths outside root", async () => {
    const { base, ctx } = await setup();
    expect((await checkPath(ctx, join(base, "secret.txt"), "read")).ok).toBe(false);
    expect((await checkPath(ctx, "/etc/passwd", "read")).ok).toBe(false);
    expect((await checkPath(ctx, join(base, "rootx", "f"), "write")).ok).toBe(false);
  });

  it("blocks symlinks pointing outside root, including for new files below them", async () => {
    const { base, root, ctx } = await setup();
    await symlink(join(base, "secret.txt"), join(root, "link.txt"));
    await symlink(base, join(root, "dirlink"));
    expect((await checkPath(ctx, "link.txt", "read")).ok).toBe(false);
    expect((await checkPath(ctx, "link.txt", "write")).ok).toBe(false);
    expect((await checkPath(ctx, "dirlink/new/file.txt", "write")).ok).toBe(false);
    // Deleting the link itself stays inside root.
    expect((await checkPath(ctx, "link.txt", "delete")).ok).toBe(true);
  });

  it("blocks by permission flag", async () => {
    const root = await tempDir();
    const ctx = makeCtx(root, { permissions: perms({ root, read: false, delete: false }) });
    const read = await checkPath(ctx, "x", "read");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.output.text).toContain(`read ${join(root, "x")}`);
    expect((await checkPath(ctx, "x", "delete")).ok).toBe(false);
    expect((await checkPath(ctx, "x", "write")).ok).toBe(true);
  });
});

describe("bashAvailable", () => {
  it("is true unless read, write, delete or network is switched off", () => {
    expect(bashAvailable(perms())).toBe(true);
    expect(bashAvailable(perms({ root: "/tmp" }))).toBe(true);
    expect(bashAvailable(perms({ read: false }))).toBe(false);
    expect(bashAvailable(perms({ write: false }))).toBe(false);
    expect(bashAvailable(perms({ delete: false }))).toBe(false);
    expect(bashAvailable(perms({ network: false }))).toBe(false);
    expect(bashAvailable(perms({ disabledTools: ["bash"] }))).toBe(false);
    expect(bashAvailable(perms({ bash: false }))).toBe(false);
  });

  it("says why bash is off, and how to enable it when that is the reason", () => {
    expect(bashDisabledReason(perms())).toBeUndefined();
    expect(bashDisabledReason(perms({ disabledTools: ["bash"] }))).toBeUndefined();
    expect(bashDisabledReason(perms({ bash: false }))).toMatch(/off by default.*--allow-bash/);
    expect(bashDisabledReason(perms({ network: false }))).toBe(
      "network is switched off, and bash runs without a sandbox, so it could get around that",
    );
    expect(bashDisabledReason(perms({ read: false, write: false }))).toMatch(/^read, write are/);
  });
});

describe("protected paths", () => {
  const p = perms();
  const matches = protectedMatcher(DEFAULT_PROTECTED_PATHS);

  it("matches secrets by name anywhere and by path suffix", () => {
    for (const f of [
      "/w/.env",
      "/w/app/.env.local",
      "/w/prod.env",
      "/w/server.pem",
      "/home/u/.ssh/id_ed25519",
      "/home/u/.ssh/config",
      "/home/u/.aws/credentials",
      "/home/u/.config/agent-box/credentials.env",
    ]) {
      expect(matches(f), f).toBe(true);
    }
  });

  it("leaves ordinary and example files alone", () => {
    for (const f of ["/w/.env.example", "/w/id_rsa.pub", "/w/src/env.ts", "/w/README.md"]) {
      expect(matches(f), f).toBe(false);
    }
  });

  it("blocks file tools from protected files, even through a symlink", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, ".env"), "SECRET=1");
    await symlink(join(dir, ".env"), join(dir, "innocent.txt"));
    const ctx = makeCtx(dir, { permissions: perms({ root: dir }) });
    for (const target of [".env", "innocent.txt"]) {
      const r = await checkPath(ctx, target, "read");
      expect(r.ok, target).toBe(false);
      if (!r.ok) expect(r.output.blocked).toBe(true);
    }
  });

  it("flags bash commands that name a protected file", () => {
    expect(protectedReference(p, "/w", "cat .env")).toBe(".env");
    expect(protectedReference(p, "/w", "grep KEY ~/.ssh/config")).toBe("~/.ssh/config");
    expect(protectedReference(p, "/w", "source app/.env.local && run")).toBe("app/.env.local");
    expect(protectedReference(p, "/w", "cp .env.example .env")).toBe(".env");
    expect(protectedReference(p, "/w", "cat .env.example")).toBeUndefined();
    expect(protectedReference(p, "/w", "npm test -- --env=ci")).toBeUndefined();
  });
});
