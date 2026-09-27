import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { ConfigError, loadConfig, parseDuration } from "../../src/config/index.js";
import type { RunConfig } from "../../src/core/types.js";
import { DEFAULT_PROTECTED_PATHS } from "../../src/permissions/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "twigg-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

function task(frontmatter?: Record<string, unknown> | string, body = "Do the thing."): string {
  if (frontmatter === undefined) return body;
  const yaml = typeof frontmatter === "string" ? frontmatter : JSON.stringify(frontmatter);
  return `---\n${yaml}\n---\n${body}\n`;
}

/** Writes task.md (and settings.json if given) and loads config with the temp dir as cwd. */
async function load(opts: {
  fm?: Record<string, unknown> | string;
  body?: string;
  settings?: Record<string, unknown>;
  flags?: string[];
}): Promise<RunConfig> {
  await write("task.md", task(opts.fm, opts.body));
  const argv = ["task.md", ...(opts.flags ?? [])];
  if (opts.settings) {
    await write("settings.json", JSON.stringify(opts.settings));
    argv.push("--settings", "settings.json");
  }
  const res = await loadConfig(argv, { cwd: dir });
  if (res.kind !== "run") throw new Error("expected run");
  return res.config;
}

async function loadError(opts: Parameters<typeof load>[0]): Promise<ConfigError> {
  const err = await load(opts).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConfigError);
  return err as ConfigError;
}

describe("help and version", () => {
  it("returns help text", async () => {
    for (const flag of ["-h", "--help"]) {
      const res = await loadConfig([flag]);
      expect(res.kind).toBe("help");
      if (res.kind === "help") expect(res.text).toContain("Usage:");
    }
  });

  it("returns the package version", async () => {
    expect(await loadConfig(["-v"])).toEqual({ kind: "version", text: pkg.version });
    expect(await loadConfig(["--version", "x.md"])).toEqual({ kind: "version", text: pkg.version });
  });

  it("rejects missing instructions, extra positionals and unknown flags", async () => {
    await expect(loadConfig([], { cwd: dir })).rejects.toThrow(/instructions/);
    await expect(loadConfig(["a.md", "b.md"], { cwd: dir })).rejects.toThrow(ConfigError);
    await expect(loadConfig(["a.md", "--bogus"], { cwd: dir })).rejects.toThrow(/bogus/);
  });
});

describe("defaults", () => {
  it("fills every default", async () => {
    const c = await load({ flags: ["--model", "m1"] });
    expect(c).toEqual({
      instructionsPath: "task.md",
      task: "Do the thing.",
      model: "m1",
      fallbackModel: undefined,
      namespace: "local",
      subagentModels: ["m1"],
      maxConcurrentSubagents: 3,
      maxTokens: undefined,
      reasoningEffort: undefined,
      permissions: {
        fs: { root: dir, read: true, write: true, delete: true },
        network: true,
        bash: false,
        disabledTools: [],
        protectedPaths: DEFAULT_PROTECTED_PATHS,
      },
      limits: {
        maxCostUsd: undefined,
        maxTurns: 100,
        timeoutMs: 30 * 60_000,
        toolTimeoutMs: 2 * 60_000,
        warnAt: 0.8,
      },
      outputPath: undefined,
      logFormat: "human",
      logFile: undefined,
      progressEvery: 5,
      cwd: dir,
      tools: [],
    } satisfies RunConfig);
  });

  it("requires a model", async () => {
    expect((await loadError({})).message).toMatch(/model/);
  });
});

describe("flags", () => {
  it("maps every flag", async () => {
    await mkdir(path.join(dir, "work"));
    const c = await load({
      flags: [
        "--model=m1",
        "--fallback-model=m2",
        "--namespace=acme/proj_1",
        "--cwd=work",
        "--root=work",
        "--no-read",
        "--no-write",
        "--no-delete",
        "--no-network",
        "--disable-tool=bash",
        "--disable-tool=web_fetch",
        "--subagent-model=s1",
        "--subagent-model=s2",
        "--max-concurrent-subagents=2",
        "--max-cost=1.5",
        "--max-turns=7",
        "--timeout=90s",
        "--tool-timeout=500",
        "--warn-at=0.5",
        "--max-tokens=1000",
        "--reasoning-effort=x_high",
        "--output=out/result.json",
        "--log-format=json",
        "--log-file=logs/run.jsonl",
        "--progress-every=2",
      ],
    });
    expect(c).toMatchObject({
      model: "m1",
      fallbackModel: "m2",
      namespace: "acme/proj_1",
      cwd: path.join(dir, "work"),
      subagentModels: ["s1", "s2"],
      maxConcurrentSubagents: 2,
      maxTokens: 1000,
      reasoningEffort: "x_high",
      permissions: {
        fs: { root: path.join(dir, "work"), read: false, write: false, delete: false },
        network: false,
        disabledTools: ["bash", "web_fetch"],
      },
      limits: { maxCostUsd: 1.5, maxTurns: 7, timeoutMs: 90_000, toolTimeoutMs: 500, warnAt: 0.5 },
      outputPath: path.join(dir, "out/result.json"),
      logFormat: "json",
      logFile: path.join(dir, "logs/run.jsonl"),
      progressEvery: 2,
    });
  });

  it.each([
    ["--max-turns", "0"],
    ["--max-turns", "1.5"],
    ["--max-tokens", "abc"],
    ["--max-concurrent-subagents", "-1"],
    ["--progress-every", "0"],
    ["--max-cost", "0"],
    ["--warn-at", "1"],
    ["--warn-at", "0"],
    ["--timeout", "5 minutes"],
    ["--tool-timeout", "0s"],
    ["--reasoning-effort", "extreme"],
    ["--log-format", "text"],
    ["--namespace", "Acme"],
  ])("rejects %s %s", async (flag, value) => {
    const err = await loadError({ flags: ["--model", "m", `${flag}=${value}`] });
    expect(err.message).toContain(flag);
  });

  it("rejects a missing cwd directory", async () => {
    expect((await loadError({ flags: ["--model", "m", "--cwd", "nope"] })).message).toMatch(
      /--cwd/,
    );
  });
});

describe("namespace validation", () => {
  it.each(["local", "acme/x", "a-b_c/d1/e2"])("accepts %s", async (ns) => {
    expect((await load({ flags: ["--model", "m", "--namespace", ns] })).namespace).toBe(ns);
  });
  it.each(["Acme", "acme/", "/acme", "acme//x", "a.b", "a".repeat(65)])(
    "rejects %s",
    async (ns) => {
      expect((await loadError({ settings: { model: "m", namespace: ns } })).message).toMatch(
        /namespace/,
      );
    },
  );
});

describe("durations", () => {
  it.each([
    ["90s", 90_000],
    ["30m", 1_800_000],
    ["1h", 3_600_000],
    ["250ms", 250],
    ["1500", 1500],
    [2000, 2000],
    ["1.5s", 1500],
  ] as const)("parses %s", (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });
  it.each(["", "abc", "10d", "-5s", "0", 0, -1])("rejects %s", (input) => {
    expect(parseDuration(input)).toBeUndefined();
  });

  it("accepts durations as strings or ms in files", async () => {
    const c = await load({
      settings: { model: "m", limits: { timeout: "1h", toolTimeout: 3000 } },
    });
    expect(c.limits.timeoutMs).toBe(3_600_000);
    expect(c.limits.toolTimeoutMs).toBe(3000);
  });

  it("rejects bad durations in files naming the field", async () => {
    const err = await loadError({ settings: { model: "m", limits: { timeout: "soon" } } });
    expect(err.message).toMatch(/limits\.timeout/);
  });
});

describe("frontmatter parsing", () => {
  it("treats a file without frontmatter as the whole task", async () => {
    const c = await load({ body: "# Title\n\nSome --- text\n", flags: ["--model", "m"] });
    expect(c.task).toBe("# Title\n\nSome --- text");
  });

  it("strips frontmatter and uses the body as task", async () => {
    const c = await load({ fm: "model: fm-model\nnamespace: acme", body: "\nBody here\n" });
    expect(c.model).toBe("fm-model");
    expect(c.namespace).toBe("acme");
    expect(c.task).toBe("Body here");
  });

  it("allows empty frontmatter", async () => {
    await write("task.md", "---\n---\nhello");
    const res = await loadConfig(["task.md", "--model", "m"], { cwd: dir });
    expect(res.kind === "run" && res.config.task).toBe("hello");
  });

  it("rejects an empty body", async () => {
    expect((await loadError({ fm: "model: m", body: "  \n" })).message).toMatch(/empty body/);
  });

  it("rejects a missing instructions file", async () => {
    await expect(loadConfig(["missing.md", "--model", "m"], { cwd: dir })).rejects.toThrow(
      /instructions file/,
    );
  });

  it("rejects unknown keys, bad YAML and unclosed frontmatter", async () => {
    expect((await loadError({ fm: "model: m\nbogus: 1" })).message).toMatch(/frontmatter.*bogus/);
    expect(
      (await loadError({ fm: "permissions: { rot: /x }", flags: ["--model", "m"] })).message,
    ).toMatch(/permissions.*rot/);
    expect((await loadError({ fm: "model: [unclosed" })).message).toMatch(/frontmatter/);
    await write("task.md", "---\nmodel: m\nbody");
    await expect(loadConfig(["task.md"], { cwd: dir })).rejects.toThrow(/closing/);
    expect((await loadError({ fm: "- a\n- b", flags: ["--model", "m"] })).message).toMatch(
      /mapping/,
    );
  });
});

describe("settings file", () => {
  it("rejects unknown keys and invalid JSON", async () => {
    expect((await loadError({ settings: { model: "m", modle: "x" } })).message).toMatch(/modle/);
    await write("task.md", "hi");
    await write("bad.json", "{nope");
    await expect(loadConfig(["task.md", "--settings", "bad.json"], { cwd: dir })).rejects.toThrow(
      /--settings/,
    );
    await expect(loadConfig(["task.md", "--settings", "none.json"], { cwd: dir })).rejects.toThrow(
      /--settings/,
    );
  });

  it("resolves its relative paths against its own directory", async () => {
    await mkdir(path.join(dir, "conf/data"), { recursive: true });
    await write("task.md", "hi");
    await write(
      "conf/s.json",
      JSON.stringify({
        model: "m",
        permissions: { root: "data" },
        output: "r.json",
        logFile: "l.jsonl",
      }),
    );
    const res = await loadConfig(["task.md", "--settings", "conf/s.json"], { cwd: dir });
    if (res.kind !== "run") throw new Error();
    expect(res.config.permissions.fs.root).toBe(path.join(dir, "conf/data"));
    expect(res.config.outputPath).toBe(path.join(dir, "conf/r.json"));
    expect(res.config.logFile).toBe(path.join(dir, "conf/l.jsonl"));
  });

  it("resolves frontmatter paths against the invocation cwd", async () => {
    await mkdir(path.join(dir, "sub"));
    const c = await load({ fm: { model: "m", output: "o.json", permissions: { root: "sub" } } });
    expect(c.outputPath).toBe(path.join(dir, "o.json"));
    expect(c.permissions.fs.root).toBe(path.join(dir, "sub"));
  });
});

describe("precedence", () => {
  // field -> [settings value, frontmatter value, flag args, RunConfig getter]
  const free = [
    ["model", "model", ["--model", "flag"], (c: RunConfig) => c.model],
    [
      "fallbackModel",
      "fallbackModel",
      ["--fallback-model", "flag"],
      (c: RunConfig) => c.fallbackModel,
    ],
    ["namespace", "namespace", ["--namespace", "flag"], (c: RunConfig) => c.namespace],
    [
      "output",
      "output",
      ["--output", "flag"],
      (c: RunConfig) => c.outputPath && path.basename(c.outputPath),
    ],
    [
      "logFile",
      "logFile",
      ["--log-file", "flag"],
      (c: RunConfig) => c.logFile && path.basename(c.logFile),
    ],
  ] as const;

  it.each(free)("%s: flags > frontmatter > settings", async (key, _k, flagArgs, get) => {
    const base = { model: "m" };
    const s = { ...base, [key]: "settings" };
    const f = { [key]: "frontmatter" };
    expect(get(await load({ settings: s }))).toBe("settings");
    expect(get(await load({ settings: s, fm: f }))).toBe("frontmatter");
    expect(get(await load({ settings: s, fm: f, flags: [...flagArgs] }))).toBe("flag");
  });

  it("numeric and enum free fields follow the same order", async () => {
    const s = {
      model: "m",
      maxTokens: 10,
      reasoningEffort: "low",
      logFormat: "json",
      progressEvery: 3,
    };
    const f = { maxTokens: 20, reasoningEffort: "high", logFormat: "human", progressEvery: 4 };
    let c = await load({ settings: s });
    expect([c.maxTokens, c.reasoningEffort, c.logFormat, c.progressEvery]).toEqual([
      10,
      "low",
      "json",
      3,
    ]);
    c = await load({ settings: s, fm: f });
    expect([c.maxTokens, c.reasoningEffort, c.logFormat, c.progressEvery]).toEqual([
      20,
      "high",
      "human",
      4,
    ]);
    c = await load({
      settings: s,
      fm: f,
      flags: [
        "--max-tokens=30",
        "--reasoning-effort=max",
        "--log-format=json",
        "--progress-every=6",
      ],
    });
    expect([c.maxTokens, c.reasoningEffort, c.logFormat, c.progressEvery]).toEqual([
      30,
      "max",
      "json",
      6,
    ]);
  });

  it("flags may loosen the settings file", async () => {
    const c = await load({
      settings: {
        model: "m",
        limits: { maxTurns: 5, maxCostUsd: 1 },
        subagents: { models: ["a"], maxConcurrent: 1 },
      },
      flags: [
        "--max-turns=50",
        "--max-cost=9",
        "--subagent-model=b",
        "--max-concurrent-subagents=8",
      ],
    });
    expect(c.limits.maxTurns).toBe(50);
    expect(c.limits.maxCostUsd).toBe(9);
    expect(c.subagentModels).toEqual(["b"]);
    expect(c.maxConcurrentSubagents).toBe(8);
  });

  it("unions disabled tools from settings and flags", async () => {
    const c = await load({
      settings: { model: "m", permissions: { disabledTools: ["a"] } },
      flags: ["--disable-tool=b"],
    });
    expect(c.permissions.disabledTools).toEqual(["a", "b"]);
  });

  it("a tighter frontmatter value wins over a looser flag", async () => {
    const c = await load({
      fm: { limits: { maxTurns: 5 } },
      flags: ["--model=m", "--max-turns=50"],
    });
    expect(c.limits.maxTurns).toBe(5);
  });
});

describe("tighten-only frontmatter", () => {
  describe("booleans", () => {
    it.each(["read", "write", "delete", "network"] as const)(
      "%s: true→false allowed",
      async (k) => {
        const c = await load({ settings: { model: "m" }, fm: { permissions: { [k]: false } } });
        const v = k === "network" ? c.permissions.network : c.permissions.fs[k];
        expect(v).toBe(false);
      },
    );
    it.each(["read", "write", "delete", "network"] as const)(
      "%s: false→true rejected (settings)",
      async (k) => {
        const err = await loadError({
          settings: { model: "m", permissions: { [k]: false } },
          fm: { permissions: { [k]: true } },
        });
        expect(err.message).toContain(`permissions.${k}`);
      },
    );
    it("false→true rejected (flag)", async () => {
      const err = await loadError({
        fm: { permissions: { network: true } },
        flags: ["--model=m", "--no-network"],
      });
      expect(err.message).toContain("permissions.network");
    });
    it("true stays true", async () => {
      const c = await load({ settings: { model: "m" }, fm: { permissions: { read: true } } });
      expect(c.permissions.fs.read).toBe(true);
    });
  });

  describe("root", () => {
    it("allows a root inside the base root", async () => {
      await mkdir(path.join(dir, "a/b"), { recursive: true });
      const c = await load({
        fm: { permissions: { root: "a/b" } },
        flags: ["--model=m", "--root=a"],
      });
      expect(c.permissions.fs.root).toBe(path.join(dir, "a/b"));
    });
    it("allows the same root and anything under the default /", async () => {
      await mkdir(path.join(dir, "a"));
      const same = await load({
        fm: { permissions: { root: "a" } },
        flags: ["--model=m", "--root=a"],
      });
      expect(same.permissions.fs.root).toBe(path.join(dir, "a"));
      const any = await load({ fm: { model: "m", permissions: { root: dir } } });
      expect(any.permissions.fs.root).toBe(dir);
    });
    it.each(["..", "/", "../a-sibling", "a/../.."])(
      "rejects %s outside the base root",
      async (r) => {
        await mkdir(path.join(dir, "a"), { recursive: true });
        const err = await loadError({
          fm: { permissions: { root: r } },
          flags: ["--model=m", "--root=a"],
        });
        expect(err.message).toContain("permissions.root");
      },
    );
    it("rejects a prefix-sharing sibling", async () => {
      await mkdir(path.join(dir, "ab"), { recursive: true });
      await mkdir(path.join(dir, "a"), { recursive: true });
      const err = await loadError({
        fm: { permissions: { root: "ab" } },
        flags: ["--model=m", "--root=a"],
      });
      expect(err.message).toContain("permissions.root");
    });
  });

  it("disabledTools only adds", async () => {
    const c = await load({
      settings: { model: "m", permissions: { disabledTools: ["bash"] } },
      fm: { permissions: { disabledTools: ["web_fetch"] } },
    });
    expect(c.permissions.disabledTools).toEqual(["bash", "web_fetch"]);
  });

  describe("numeric limits", () => {
    const cases = [
      ["maxTurns", 10, 5, 20, (c: RunConfig) => c.limits.maxTurns],
      ["maxCostUsd", 2, 1, 3, (c: RunConfig) => c.limits.maxCostUsd],
      ["timeout", "10m", "5m", "1h", (c: RunConfig) => c.limits.timeoutMs],
      ["toolTimeout", 60_000, "30s", "2m", (c: RunConfig) => c.limits.toolTimeoutMs],
      ["warnAt", 0.7, 0.5, 0.9, (c: RunConfig) => c.limits.warnAt],
    ] as const;

    it.each(cases)("%s: lowering allowed", async (k, base, lower, _higher, get) => {
      const c = await load({
        settings: { model: "m", limits: { [k]: base } },
        fm: { limits: { [k]: lower } },
      });
      const expected = await load({ settings: { model: "m", limits: { [k]: lower } } });
      expect(get(c)).toBe(get(expected));
    });

    it.each(cases)("%s: raising rejected", async (k, base, _lower, higher) => {
      const err = await loadError({
        settings: { model: "m", limits: { [k]: base } },
        fm: { limits: { [k]: higher } },
      });
      expect(err.message).toContain(`limits.${k}`);
    });

    it("raising above a default is rejected", async () => {
      const err = await loadError({ fm: { model: "m", limits: { maxTurns: 101 } } });
      expect(err.message).toContain("limits.maxTurns");
      const err2 = await loadError({ fm: { model: "m", limits: { timeout: "31m" } } });
      expect(err2.message).toContain("limits.timeout");
    });

    it("an unset limit may be set to anything", async () => {
      const c = await load({ fm: { model: "m", limits: { maxCostUsd: 1000 } } });
      expect(c.limits.maxCostUsd).toBe(1000);
    });

    it("raising a flag value is rejected", async () => {
      const err = await loadError({
        fm: { limits: { maxTurns: 11 } },
        flags: ["--model=m", "--max-turns=10"],
      });
      expect(err.message).toContain("limits.maxTurns");
    });
  });

  describe("subagents", () => {
    it("models: subset allowed", async () => {
      const c = await load({
        settings: { model: "m", subagents: { models: ["a", "b"] } },
        fm: { subagents: { models: ["b"] } },
      });
      expect(c.subagentModels).toEqual(["b"]);
    });
    it("models: empty list allowed (disables subagents)", async () => {
      const c = await load({ settings: { model: "m" }, fm: { subagents: { models: [] } } });
      expect(c.subagentModels).toEqual([]);
    });
    it("models: adding rejected", async () => {
      const err = await loadError({
        settings: { model: "m", subagents: { models: ["a"] } },
        fm: { subagents: { models: ["a", "c"] } },
      });
      expect(err.message).toContain("subagents.models");
    });
    it("models: default base is [model]", async () => {
      const ok = await load({ fm: { model: "fm", subagents: { models: ["fm"] } } });
      expect(ok.subagentModels).toEqual(["fm"]);
      const err = await loadError({ fm: { model: "fm", subagents: { models: ["other"] } } });
      expect(err.message).toContain("subagents.models");
    });
    it("maxConcurrent: lowering allowed, raising rejected", async () => {
      const c = await load({ settings: { model: "m" }, fm: { subagents: { maxConcurrent: 1 } } });
      expect(c.maxConcurrentSubagents).toBe(1);
      const err = await loadError({
        settings: { model: "m" },
        fm: { subagents: { maxConcurrent: 4 } },
      });
      expect(err.message).toContain("subagents.maxConcurrent");
    });
  });
});

describe("root default follows cwd", () => {
  it("defaults root to --cwd", async () => {
    const sub = path.join(dir, "work");
    await mkdir(sub, { recursive: true });
    const c = await load({ flags: ["--model", "m1", "--cwd", sub] });
    expect(c.permissions.fs.root).toBe(sub);
  });

  it("rejects a frontmatter root outside the default root", async () => {
    await expect(
      load({ flags: ["--model", "m1"], fm: { permissions: { root: "/" } } }),
    ).rejects.toThrow(/must be inside/);
  });
});

describe("custom tools", () => {
  /** A package installed in the temp dir's node_modules. */
  async function installPackage(name: string) {
    await write(`node_modules/${name}/tool.json`, "{}");
    return path.join(dir, "node_modules", name);
  }

  it("resolves settings paths against the settings file and --tool against the cwd", async () => {
    await mkdir(path.join(dir, "conf"));
    await write("conf/settings.json", JSON.stringify({ tools: ["./mine"] }));
    await write("task.md", task());
    const res = await loadConfig(
      ["task.md", "--model=m", "--settings=conf/settings.json", "--tool=./other"],
      { cwd: dir },
    );
    if (res.kind !== "run") throw new Error("expected run");
    expect(res.config.tools).toEqual([
      { use: "./mine", env: {}, dir: path.join(dir, "conf", "mine") },
      { use: "./other", env: {}, dir: path.join(dir, "other") },
    ]);
  });

  it("finds packages in node_modules and keeps env from settings", async () => {
    const pkgDir = await installPackage("@acme/tool");
    const c = await load({
      flags: ["--model=m"],
      settings: { tools: [{ use: "@acme/tool", env: { UNITS: "metric" } }, "not-installed"] },
    });
    expect(c.tools).toEqual([
      { use: "@acme/tool", env: { UNITS: "metric" }, dir: pkgDir },
      { use: "not-installed", env: {} },
    ]);
  });

  it("loads a tool listed twice once", async () => {
    await installPackage("dup");
    const c = await load({ flags: ["--model=m", "--tool=dup"], settings: { tools: ["dup"] } });
    expect(c.tools).toHaveLength(1);
  });

  it("protects tool folders and the state directory", async () => {
    const c = await load({ flags: ["--model=m", "--tool=./mine"] });
    expect(c.permissions.protectedPaths).toEqual(
      expect.arrayContaining([
        `${path.join(dir, "mine")}/**`,
        `${path.join(dir, ".twigg-agent")}/**`,
      ]),
    );
  });

  it("refuses tools in frontmatter", async () => {
    expect((await loadError({ fm: { model: "m", tools: ["x"] } })).message).toMatch(
      /tools can only be set/,
    );
  });

  it("has a tools command that needs no instructions file", async () => {
    expect(await loadConfig(["tools", "--tool", "./t"], { cwd: dir })).toEqual({
      kind: "tools",
      tools: [{ use: "./t", env: {}, dir: path.join(dir, "t") }],
    });
    expect(await loadConfig(["tools"], { cwd: dir })).toEqual({ kind: "tools", tools: [] });
  });

  it("has a models command that needs no instructions file", async () => {
    expect(await loadConfig(["models"], { cwd: dir })).toEqual({ kind: "models" });
  });
});

describe("bash", () => {
  it("is off by default and enabled by --allow-bash or settings", async () => {
    expect((await load({ flags: ["--model=m"] })).permissions.bash).toBe(false);
    expect((await load({ flags: ["--model=m", "--allow-bash"] })).permissions.bash).toBe(true);
    const fromSettings = await load({
      flags: ["--model=m"],
      settings: { permissions: { bash: true } },
    });
    expect(fromSettings.permissions.bash).toBe(true);
  });

  it("can be turned off, but not on, by frontmatter", async () => {
    const off = await load({
      flags: ["--model=m", "--allow-bash"],
      fm: { permissions: { bash: false } },
    });
    expect(off.permissions.bash).toBe(false);
    expect(
      (await loadError({ flags: ["--model=m"], fm: { permissions: { bash: true } } })).message,
    ).toMatch(/cannot enable bash/);
  });
});
