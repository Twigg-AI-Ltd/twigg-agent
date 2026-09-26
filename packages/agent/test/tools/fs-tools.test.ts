import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteTool } from "../../src/tools/delete.js";
import { editTool } from "../../src/tools/edit.js";
import { globTool } from "../../src/tools/glob.js";
import { grepTool } from "../../src/tools/grep.js";
import { readTool } from "../../src/tools/read.js";
import { todoTool } from "../../src/tools/todo.js";
import { writeTool } from "../../src/tools/write.js";
import { makeCtx, perms, tempDir } from "./helpers.js";

describe("read", () => {
  it("numbers lines and pages with offset/limit", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "f.txt"), "one\ntwo\nthree\n");
    const ctx = makeCtx(dir);
    const all = await readTool.run({ path: "f.txt" }, ctx);
    expect(all).toEqual({ isError: false, text: "     1\tone\n     2\ttwo\n     3\tthree\n" });
    const part = await readTool.run({ path: "f.txt", offset: 2, limit: 1 }, ctx);
    expect(part.text).toContain("     2\ttwo");
    expect(part.text).toContain("Use offset=3");
  });

  it("caps output", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "big.txt"), `${"x".repeat(1000)}\n`.repeat(500));
    const out = await readTool.run({ path: "big.txt" }, makeCtx(dir));
    expect(out.text.length).toBeLessThan(101_000);
    expect(out.text).toContain("Showing lines 1-");
  });

  it("rejects invalid input without throwing", async () => {
    const out = await readTool.run({ path: 3 }, makeCtx(await tempDir()));
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Invalid input for read");
  });
});

describe("write", () => {
  it("creates parent dirs and overwrites with write permission only", async () => {
    const dir = await tempDir();
    const ctx = makeCtx(dir, { permissions: perms({ root: dir, delete: false }) });
    expect((await writeTool.run({ path: "a/b/c.txt", content: "hi" }, ctx)).isError).toBe(false);
    expect((await writeTool.run({ path: "a/b/c.txt", content: "bye" }, ctx)).isError).toBe(false);
    expect(await readFile(join(dir, "a/b/c.txt"), "utf8")).toBe("bye");
  });
});

describe("edit", () => {
  async function setup(content: string) {
    const dir = await tempDir();
    const file = join(dir, "f.txt");
    await writeFile(file, content);
    return { dir, file, ctx: makeCtx(dir) };
  }

  it("requires a prior read by the same agent", async () => {
    const { file, ctx, dir } = await setup("hello");
    const out = await editTool.run({ path: file, old_string: "hello", new_string: "bye" }, ctx);
    expect(out).toMatchObject({ isError: true });
    expect(out.blocked).toBeUndefined();
    await readTool.run({ path: file }, makeCtx(dir, { agentId: "sub-1" }));
    expect(
      (await editTool.run({ path: file, old_string: "hello", new_string: "x" }, ctx)).isError,
    ).toBe(true);
  });

  it("fails when the file changed after the read", async () => {
    const { file, ctx } = await setup("hello");
    await readTool.run({ path: file }, ctx);
    await writeFile(file, "hello world");
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    const out = await editTool.run({ path: file, old_string: "hello", new_string: "bye" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("changed on disk");
  });

  it("enforces uniqueness unless replace_all, and allows consecutive edits", async () => {
    const { file, ctx } = await setup("a $& a b");
    await readTool.run({ path: file }, ctx);
    const dup = await editTool.run({ path: file, old_string: "a", new_string: "z" }, ctx);
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("2 times");
    expect(
      (await editTool.run({ path: file, old_string: "b", new_string: "$&" }, ctx)).isError,
    ).toBe(false);
    const all = await editTool.run(
      { path: file, old_string: "a", new_string: "z", replace_all: true },
      ctx,
    );
    expect(all.isError).toBe(false);
    expect(await readFile(file, "utf8")).toBe("z $& z $&");
    const missing = await editTool.run({ path: file, old_string: "q", new_string: "r" }, ctx);
    expect(missing.text).toContain("not found");
  });
});

describe("delete", () => {
  it("deletes files and requires recursive for directories", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "d"));
    await writeFile(join(dir, "d/f.txt"), "x");
    const ctx = makeCtx(dir);
    expect((await deleteTool.run({ path: "d" }, ctx)).isError).toBe(true);
    expect((await deleteTool.run({ path: "d/f.txt" }, ctx)).isError).toBe(false);
    expect((await deleteTool.run({ path: "d", recursive: true }, ctx)).isError).toBe(false);
    await expect(stat(join(dir, "d"))).rejects.toThrow();
  });
});

describe("glob and grep", () => {
  async function setup() {
    const dir = await tempDir();
    await mkdir(join(dir, "src/sub"), { recursive: true });
    await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "const foo = 1;\nconst bar = 2;\n");
    await writeFile(join(dir, "src/sub/b.ts"), "export const FOO = 3;\n");
    await writeFile(join(dir, "src/c.md"), "foo in markdown\n");
    await writeFile(join(dir, "src/bin.dat"), Buffer.from([102, 111, 111, 0, 1]));
    await writeFile(join(dir, "node_modules/pkg/foo.ts"), "foo\n");
    return { dir, ctx: makeCtx(dir) };
  }

  it("glob finds files and ignores node_modules", async () => {
    const { ctx } = await setup();
    const out = await globTool.run({ pattern: "**/*.ts" }, ctx);
    expect(out.text.split("\n")).toEqual(["src/a.ts", "src/sub/b.ts"]);
    expect((await globTool.run({ pattern: "../**" }, ctx)).isError).toBe(true);
  });

  it("grep matches with file:line and respects glob, case and binary skipping", async () => {
    const { ctx } = await setup();
    const out = await grepTool.run({ pattern: "foo" }, ctx);
    expect(out.text.split("\n")).toEqual([
      "src/a.ts:1: const foo = 1;",
      "src/c.md:1: foo in markdown",
    ]);
    const ci = await grepTool.run({ pattern: "foo", glob: "*.ts", ignore_case: true }, ctx);
    expect(ci.text.split("\n")).toEqual([
      "src/a.ts:1: const foo = 1;",
      "src/sub/b.ts:1: export const FOO = 3;",
    ]);
    expect((await grepTool.run({ pattern: "(" }, ctx)).text).toContain(
      "Invalid regular expression",
    );
  });

  it("grep and glob block paths outside root", async () => {
    const { ctx } = await setup();
    expect((await grepTool.run({ pattern: "x", path: "/etc" }, ctx)).blocked).toBe(true);
    expect((await globTool.run({ pattern: "*", path: ".." }, ctx)).blocked).toBe(true);
  });
});

describe("permission flags", () => {
  it("block the matching tools", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "f.txt"), "x");
    const none = makeCtx(dir, {
      permissions: perms({ root: dir, read: false, write: false, delete: false }),
    });
    expect((await readTool.run({ path: "f.txt" }, none)).blocked).toBe(true);
    expect((await globTool.run({ pattern: "*" }, none)).blocked).toBe(true);
    expect((await grepTool.run({ pattern: "x" }, none)).blocked).toBe(true);
    expect((await writeTool.run({ path: "g.txt", content: "" }, none)).blocked).toBe(true);
    expect(
      (await editTool.run({ path: "f.txt", old_string: "x", new_string: "y" }, none)).blocked,
    ).toBe(true);
    expect((await deleteTool.run({ path: "f.txt" }, none)).blocked).toBe(true);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("x");
  });
});

describe("todo", () => {
  it("logs the checklist and acks with counts", async () => {
    const ctx = makeCtx(await tempDir());
    const items = [
      { text: "a", done: true },
      { text: "b", done: false },
    ];
    const out = await todoTool.run({ items }, ctx);
    expect(out.text).toBe("Checklist updated: 1/2 done.");
    expect(ctx.events).toEqual([{ type: "todo", agentId: "main", items }]);
  });
});
