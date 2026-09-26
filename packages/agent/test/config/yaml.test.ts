import { describe, expect, it } from "vitest";
import { parseYaml } from "../../src/config/yaml.js";

describe("parseYaml", () => {
  it("reads nested mappings and lists", () => {
    const text = [
      "# a task",
      "model: m",
      "limits:",
      "  maxTurns: 25 # per run",
      "  timeout: 5m",
      "",
      "permissions:",
      "  network: false",
      "  disabledTools: [wait, bash]",
      "  protectedPaths:",
      '    - "private/**"',
      "    - '*.key'",
      "    - plain/*",
      "tools:",
      "- one",
      "- use: two",
      "  env:",
      "    KEY: value",
    ].join("\r\n");
    expect(parseYaml(text)).toEqual({
      model: "m",
      limits: { maxTurns: 25, timeout: "5m" },
      permissions: {
        network: false,
        disabledTools: ["wait", "bash"],
        protectedPaths: ["private/**", "*.key", "plain/*"],
      },
      tools: ["one", { use: "two", env: { KEY: "value" } }],
    });
  });

  it("reads scalars", () => {
    expect(
      parseYaml(
        "a: 1\nb: -2.5\nc: 1e3\nd: 0x1f\ne: true\nf: False\ng: null\nh: ~\ni:\nj: yes\n" +
          "k: 12abc\nl: 'it''s'\nm: \"a\\n\\u00e9 # b\" # c\nn: x#y\no: http://a.test/b?c#d\np: '1'",
      ),
    ).toEqual({
      a: 1,
      b: -2.5,
      c: 1000,
      d: 31,
      e: true,
      f: false,
      g: null,
      h: null,
      i: null,
      j: "yes",
      k: "12abc",
      l: "it's",
      m: "a\né # b",
      n: "x#y",
      o: "http://a.test/b?c#d",
      p: "1",
    });
  });

  it("reads inline collections, which covers JSON", () => {
    expect(parseYaml("a: {b: 1, 'c d': [x, {e: f}], g: []}")).toEqual({
      a: { b: 1, "c d": ["x", { e: "f" }], g: [] },
    });
    const value = { model: "m", limits: { maxTurns: 3 }, list: ["a, b", 1, null, true], e: {} };
    expect(parseYaml(JSON.stringify(value))).toEqual(value);
    expect(parseYaml(JSON.stringify(value, null, 2))).toEqual(value);
    expect(parseYaml("a: [1,\n  2]\nb: 3")).toEqual({ a: [1, 2], b: 3 });
  });

  it("reads documents that aren't mappings", () => {
    expect(parseYaml("- a\n- b")).toEqual(["a", "b"]);
    expect(parseYaml("- - 1\n  - 2\n- x")).toEqual([[1, 2], "x"]);
    expect(parseYaml("just text")).toBe("just text");
    expect(parseYaml("")).toBeNull();
    expect(parseYaml("# nothing\n\n")).toBeNull();
  });

  it("keeps __proto__ as a plain key", () => {
    const parsed = parseYaml('__proto__: {x: 1}\nb: {"__proto__": 2}') as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["__proto__", "b"]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it.each([
    ["a: [unclosed", /line 1: missing closing \]/],
    ["a: {b: 1", /line 1: missing closing \}/],
    ['a: "unclosed', /line 1: missing closing "/],
    ["a: 1\na: 2", /line 2: the key "a" is there twice/],
    ["{a: 1, a: 2}", /twice/],
    ["a: 1\n b: 2", /line 2: unexpected indentation/],
    ["a:\n    b: 1\n  c: 2", /line 3/],
    ["a:\n\tb: 1", /line 2: indent with spaces/],
    ["a: 1\n---\nb: 2", /line 2: only one document/],
    ["a: &x 1", /line 1: "&" is not supported/],
    ["a: *x", /"\*" is not supported/],
    ["a: !!str 1", /"!" is not supported/],
    ["a: |\n  text", /"\|" is not supported/],
    ["a: >\n  text", /">" is not supported/],
    ["a: - b", /"-" is not supported/],
    ["a: .inf", /not supported/],
    ["a: b: c", /must be in quotes/],
    ["a: text\n  continued", /line 2/],
    ["a: 'multi\n  line'", /line 1: missing closing '/],
    ["a: [x\n  y]", /can't continue on the next line/],
    ['a: "x" y', /line 1: unexpected "y"/],
    ["a: [1, 2] x", /unexpected "x"/],
    ["a: 1\nnot an entry", /line 2: expected "key: value"/],
    ["- a\nb: c", /line 2: unexpected "b: c"/],
    ['a: "\\x41"', /invalid escape/],
  ])("rejects %j", (text, message) => {
    expect(() => parseYaml(text)).toThrow(message);
  });
});
