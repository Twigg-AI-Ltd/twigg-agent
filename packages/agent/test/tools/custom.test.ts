import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolSource } from "../../src/core/types.js";
import { type CustomTool, loadCustomTools, resolveToolDir } from "../../src/tools/custom.js";
import { buildTools } from "../../src/tools/index.js";
import { makeCtx, perms, tempDir } from "./helpers.js";

const schema = { type: "object", properties: {} };

/** Writes a tool folder `dir/folder` with a tool.json from `manifest`, plus any extra files. */
async function addTool(
  dir: string,
  folder: string,
  manifest: Record<string, unknown> | Record<string, unknown>[],
  files: Record<string, string> = {},
): Promise<string> {
  const toolDir = join(dir, folder);
  await mkdir(toolDir, { recursive: true });
  const one = (m: Record<string, unknown>) => ({
    name: folder,
    description: "d",
    input_schema: schema,
    ...m,
  });
  await writeFile(
    join(toolDir, "tool.json"),
    JSON.stringify(Array.isArray(manifest) ? manifest.map(one) : one(manifest)),
  );
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(toolDir, name), content);
  }
  return toolDir;
}

/** A tool that runs `script` with node. */
function nodeTool(script: string, manifest: Record<string, unknown> = {}) {
  return [{ command: ["node", "t.mjs"], ...manifest }, { "t.mjs": script }] as const;
}

function source(
  dir: string | undefined,
  env: Record<string, string> = {},
  use = dir ?? "",
): ToolSource {
  return { use, env, ...(dir ? { dir } : {}) };
}

async function loadTool(
  dir: string,
  env: NodeJS.ProcessEnv = {},
  settingsEnv: Record<string, string> = {},
): Promise<CustomTool> {
  const [entry] = await loadCustomTools([source(dir, settingsEnv)], {
    PATH: process.env.PATH,
    ...env,
  });
  if (!entry || !("tool" in entry)) throw new Error(`not loaded: ${JSON.stringify(entry)}`);
  return entry.tool;
}

describe("resolveToolDir", () => {
  it("resolves paths against the base directory and ~ against home", async () => {
    expect(await resolveToolDir("./t", "/base")).toBe("/base/t");
    expect(await resolveToolDir("/abs/t", "/base")).toBe("/abs/t");
    expect(await resolveToolDir("~/t", "/base", "/home/me")).toBe("/home/me/t");
  });

  it("finds a package with a tool.json in node_modules above the base directory", async () => {
    const dir = await tempDir();
    const pkg = await addTool(join(dir, "node_modules", "@acme"), "db", { command: ["x"] });
    await mkdir(join(dir, "deep", "er"), { recursive: true });
    expect(await resolveToolDir("@acme/db", join(dir, "deep", "er"))).toBe(pkg);
    expect(await resolveToolDir("@acme/nope", dir)).toBeUndefined();
  });
});

describe("loadCustomTools", () => {
  it("reports missing, empty and broken sources", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "empty"));
    const badJson = await addTool(dir, "bad_json", {});
    await writeFile(join(badJson, "tool.json"), "{");
    const entries = await loadCustomTools(
      [
        source(undefined, {}, "@acme/missing"),
        source(join(dir, "empty")),
        source(badJson),
        source(await addTool(dir, "no_command", {})),
        source(await addTool(dir, "bash", { command: ["x"] })),
        source(await addTool(dir, "needs_key", { command: ["x"], env: ["SOME_KEY"] })),
      ],
      {},
    );
    expect(entries.map((e) => [e.name, "problem" in e ? e.problem : "ok"])).toEqual([
      ["@acme/missing", expect.stringMatching(/npm install @acme\/missing/)],
      [join(dir, "empty"), expect.stringMatching(/no tool\.json/)],
      [badJson, expect.stringMatching(/invalid JSON/)],
      [join(dir, "no_command"), expect.stringMatching(/command/)],
      ["bash", expect.stringMatching(/built-in/)],
      ["needs_key", expect.stringMatching(/missing SOME_KEY/)],
    ]);
  });

  it("reads required keys from settings, the tool's .env or the environment", async () => {
    const dir = await tempDir();
    const t = await addTool(
      dir,
      "a",
      { command: ["x"], env: ["K1", "K2", "K3"] },
      { ".env": "K1=one\n" },
    );
    expect(await loadCustomTools([source(t)], { K2: "two" })).toMatchObject([
      { problem: /missing K3/ },
    ]);
    expect(await loadCustomTools([source(t, { K3: "three" })], { K2: "two" })).toMatchObject([
      { name: "a", tool: {} },
    ]);
  });

  it("loads several tools from one folder and reports a name used twice", async () => {
    const dir = await tempDir();
    const a = await addTool(dir, "a", [
      { name: "one", command: ["x"] },
      { name: "two", command: ["x"] },
    ]);
    const b = await addTool(dir, "b", { name: "two", command: ["x"] });
    const entries = await loadCustomTools([source(a), source(b)], {});
    expect(entries.map((e) => [e.name, "tool" in e])).toEqual([
      ["one", true],
      ["two", true],
      ["two", false],
    ]);
    expect(entries[2]).toMatchObject({ problem: /already named "two"/ });
  });
});

describe("running a custom tool", () => {
  it("passes input on stdin and only the environment the tool declares or is given", async () => {
    const dir = await tempDir();
    const work = await tempDir();
    const t = await addTool(
      dir,
      "echo",
      ...nodeTool(
        `let s = ""; for await (const c of process.stdin) s += c;
         const e = process.env;
         console.log(JSON.stringify({ in: JSON.parse(s), dot: e.DOT, declared: e.DECLARED,
           given: e.GIVEN, other: e.OTHER ?? null, twigg: e.TWIGG_API_KEY ?? null,
           cwd: e.TWIGG_AGENT_CWD, state: e.TWIGG_AGENT_STATE_DIR }));`,
        { env: ["DECLARED"] },
      ),
    );
    await writeFile(join(t, ".env"), "DOT=d\n");
    const tool = await loadTool(
      t,
      { TWIGG_API_KEY: "tw_live_x", DECLARED: "yes", OTHER: "leak" },
      { GIVEN: "g" },
    );
    const out = await tool.run({ a: 1 }, makeCtx(work));
    expect(out.isError).toBe(false);
    const state = join(work, ".twigg-agent", "state", "echo");
    expect(JSON.parse(out.text)).toEqual({
      in: { a: 1 },
      dot: "d",
      declared: "yes",
      given: "g",
      other: null,
      twigg: null,
      cwd: work,
      state,
    });
    expect((await stat(state)).isDirectory()).toBe(true);
  });

  it("names a package's state directory after the package", async () => {
    const dir = await tempDir();
    const work = await tempDir();
    const t = await addTool(
      dir,
      "db",
      ...nodeTool(`console.log(process.env.TWIGG_AGENT_STATE_DIR)`),
    );
    const [entry] = await loadCustomTools([source(t, {}, "@acme/db")], { PATH: process.env.PATH });
    if (!entry || !("tool" in entry)) throw new Error("not loaded");
    const out = await entry.tool.run({}, makeCtx(work));
    expect(out.text).toBe(join(work, ".twigg-agent", "state", "acme__db"));
  });

  it("keeps state between calls", async () => {
    const dir = await tempDir();
    const work = await tempDir();
    const t = await addTool(
      dir,
      "count",
      ...nodeTool(`import { readFileSync, writeFileSync } from "node:fs";
        const f = process.env.TWIGG_AGENT_STATE_DIR + "/n";
        let n = 0; try { n = Number(readFileSync(f, "utf8")); } catch {}
        writeFileSync(f, String(n + 1)); console.log(n + 1);`),
    );
    const tool = await loadTool(t);
    await tool.run({}, makeCtx(work));
    expect((await tool.run({}, makeCtx(work))).text).toBe("2");
    expect(await readFile(join(work, ".twigg-agent", "state", "count", "n"), "utf8")).toBe("2");
  });

  it("returns stdout, stderr and the exit code on failure", async () => {
    const dir = await tempDir();
    const t = await addTool(
      dir,
      "f",
      ...nodeTool(`console.log("out"); console.error("err"); process.exit(2);`),
    );
    const out = await (await loadTool(t)).run({}, makeCtx(dir));
    expect(out).toEqual({ isError: true, text: "out\nerr\n[exit code: 2]" });
  });

  it("turns exit code 3 into a blocked result", async () => {
    const dir = await tempDir();
    const t = await addTool(dir, "p", ...nodeTool(`console.log("do the thing"); process.exit(3);`));
    const out = await (await loadTool(t)).run({}, makeCtx(dir));
    expect(out.blocked).toBe(true);
    expect(out.text).toContain("I tried to do the thing but it was blocked.");
  });

  it("kills a tool that runs past the timeout", async () => {
    const dir = await tempDir();
    const t = await addTool(dir, "slow", ...nodeTool("setTimeout(() => {}, 60_000);"));
    const out = await (await loadTool(t)).run({}, makeCtx(dir, { timeoutMs: 300 }));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/timed out/);
  });

  it("reports a command that does not exist", async () => {
    const dir = await tempDir();
    const t = await addTool(dir, "gone", { command: ["./no-such-program"] });
    const out = await (await loadTool(t)).run({}, makeCtx(dir));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/ENOENT/);
  });
});

describe("custom tool permissions", () => {
  const names = (p: ReturnType<typeof perms>, tools: CustomTool[]) =>
    buildTools(p, tools).map((t) => t.name);

  it("leaves a tool out when a permission it declares is denied", async () => {
    const dir = await tempDir();
    const writer = await loadTool(
      await addTool(dir, "writer", { command: ["x"], permissions: ["write"] }),
    );
    const net = await loadTool(await addTool(dir, "net", { command: ["x"], network: true }));
    const plain = await loadTool(await addTool(dir, "plain", { command: ["x"] }));
    const all = [writer, net, plain];
    expect(names(perms(), all)).toEqual(expect.arrayContaining(["writer", "net", "plain"]));
    expect(names(perms({ write: false }), all)).not.toContain("writer");
    expect(names(perms({ network: false }), all)).not.toContain("net");
    expect(names(perms({ write: false, network: false }), all)).toContain("plain");
    expect(names(perms({ disabledTools: ["plain"] }), all)).not.toContain("plain");
  });
});
