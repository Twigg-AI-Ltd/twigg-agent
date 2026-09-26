import { describe, expect, it } from "vitest";
import * as s from "../../src/core/schema.js";

const issuesOf = (schema: s.Schema<unknown>, value: unknown) => {
  const res = schema.parse(value);
  return res.ok ? [] : res.issues.map((i) => `${i.path}: ${i.message}`);
};

describe("schema", () => {
  const person = s.object({
    name: s.string({ min: 1 }).describe("Full name."),
    age: s.number({ int: true, min: 0 }).optional(),
    tags: s.array(s.string()).optional(),
  });

  it("describes itself as JSON Schema", () => {
    expect(person.json).toEqual({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Full name." },
        age: { type: "integer", minimum: 0 },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("keeps optional after describe, in either order", () => {
    const a = s.object({ x: s.string().optional().describe("d") });
    const b = s.object({ x: s.string().describe("d").optional() });
    expect(a.json).toEqual(b.json);
    expect(a.json.required).toBeUndefined();
    expect(a.parse({})).toEqual({ ok: true, value: {} });
  });

  it("returns the value, dropping unknown keys by default", () => {
    expect(person.parse({ name: "a", extra: 1 })).toEqual({ ok: true, value: { name: "a" } });
  });

  it("reports every issue with its path", () => {
    expect(issuesOf(person, { name: "", age: 1.5, tags: ["a", 2] })).toEqual([
      "name: must not be empty",
      "age: must be a whole number",
      "tags.1: expected a string, got number",
    ]);
    expect(issuesOf(person, {})).toEqual(["name: is required"]);
    expect(issuesOf(person, [])).toEqual([": expected an object, got array"]);
    expect(issuesOf(person, null)).toEqual([": expected an object, got null"]);
  });

  it("rejects or keeps unknown keys when asked", () => {
    const strict = s.object({ a: s.string().optional() }, "strict");
    expect(issuesOf(strict, { b: 1, c: 2 })).toEqual([": unknown key(s) b, c"]);
    const keep = s.object({ a: s.string() }, "keep");
    expect(keep.parse({ a: "x", b: 1 })).toEqual({ ok: true, value: { a: "x", b: 1 } });
    expect(keep.json.additionalProperties).toBeUndefined();
  });

  it("checks number bounds and rejects NaN and Infinity", () => {
    const n = s.number({ gt: 0, lt: 1 });
    expect(issuesOf(n, 0)).toEqual([": must be greater than 0"]);
    expect(issuesOf(n, 1)).toEqual([": must be less than 1"]);
    expect(issuesOf(n, 0.5)).toEqual([]);
    expect(issuesOf(s.number(), Number.NaN)).toHaveLength(1);
    expect(issuesOf(s.number(), Number.POSITIVE_INFINITY)).toHaveLength(1);
    expect(issuesOf(s.number(), "1")).toEqual([": expected a number, got string"]);
    expect(issuesOf(s.number({ max: 3 }), 4)).toEqual([": must be at most 3"]);
  });

  it("checks string length and pattern", () => {
    expect(issuesOf(s.string({ max: 2 }), "abc")).toEqual([": must be at most 2 characters"]);
    expect(issuesOf(s.string({ pattern: /^a+$/ }), "b")).toEqual([": must match ^a+$"]);
    expect(issuesOf(s.string({ pattern: /^a+$/, message: "only a" }), "b")).toEqual([": only a"]);
  });

  it("checks enums, records and array length", () => {
    expect(issuesOf(s.oneOf(["a", "b"]), "c")).toEqual([": must be one of a, b"]);
    expect(issuesOf(s.record(s.string()), { a: "x", b: 1 })).toEqual([
      "b: expected a string, got number",
    ]);
    expect(issuesOf(s.array(s.string(), { min: 1 }), [])).toEqual([
      ": must have at least 1 item(s)",
    ]);
  });

  it("takes the first union option that fits and names the field when none does", () => {
    const u = s.union(s.string({ min: 1 }), s.object({ use: s.string() }, "strict"));
    expect(u.parse("x")).toEqual({ ok: true, value: "x" });
    expect(u.parse({ use: "x" })).toEqual({ ok: true, value: { use: "x" } });
    expect(issuesOf(u, { use: "x", nope: 1 })).toEqual([": unknown key(s) nope"]);
    expect(issuesOf(u, { use: 3 })).toEqual(["use: expected a string, got number"]);
    expect(issuesOf(u, 3)).toEqual([": invalid value of type number"]);
  });

  it("converts with custom", () => {
    const even = s.custom(
      { type: "number" },
      (v) => (typeof v === "number" && v % 2 === 0 ? v / 2 : undefined),
      (v) => `${v} is not even`,
    );
    expect(even.parse(4)).toEqual({ ok: true, value: 2 });
    expect(issuesOf(even, 3)).toEqual([": 3 is not even"]);
  });
});
