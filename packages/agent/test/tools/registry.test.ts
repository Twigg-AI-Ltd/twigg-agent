import { describe, expect, it } from "vitest";
import { buildTools, readTool, toolDefinition } from "../../src/tools/index.js";
import { perms } from "./helpers.js";

const names = (p: Parameters<typeof buildTools>[0]) => buildTools(p).map((t) => t.name);

describe("buildTools", () => {
  it("offers everything when unrestricted", () => {
    expect(names(perms()).sort()).toEqual(
      [
        "bash",
        "delete",
        "edit",
        "glob",
        "grep",
        "read",
        "todo",
        "wait",
        "web_fetch",
        "write",
      ].sort(),
    );
  });

  it("omits tools per permission and drops bash when read, write, delete or network is off", () => {
    expect(names(perms({ read: false }))).toEqual([
      "write",
      "edit",
      "delete",
      "web_fetch",
      "todo",
      "wait",
    ]);
    expect(names(perms({ write: false }))).toEqual([
      "read",
      "glob",
      "grep",
      "delete",
      "web_fetch",
      "todo",
      "wait",
    ]);
    expect(names(perms({ delete: false }))).not.toContain("delete");
    expect(names(perms({ network: false }))).not.toContain("web_fetch");
    expect(names(perms({ root: "/home" }))).toContain("bash");
    expect(names(perms({ root: "/home" }))).toContain("read");
  });

  it("omits disabled tools", () => {
    expect(names(perms({ disabledTools: ["grep", "todo", "bash", "wait"] }))).toEqual([
      "read",
      "glob",
      "write",
      "edit",
      "delete",
      "web_fetch",
    ]);
  });
});

describe("toolDefinition", () => {
  it("maps to Twigg's shape", () => {
    const def = toolDefinition(readTool);
    expect(def.name).toBe("read");
    expect(def.description).toBe(readTool.description);
    expect(def.input_schema).toMatchObject({
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    });
    expect(def.input_schema).not.toHaveProperty("$schema");
  });
});
