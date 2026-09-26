import { describe, expect, it } from "vitest";
import { agentNamespaces } from "../../src/agent/namespace.js";

describe("agentNamespaces", () => {
  it("puts the main agent in twigg-agent/<ns> and subagents below it", () => {
    expect(agentNamespaces("acme/proj")).toEqual({
      main: "twigg-agent/acme/proj",
      subagent: "twigg-agent/acme/proj/subagent",
    });
  });

  it("does not double an existing prefix", () => {
    expect(agentNamespaces("twigg-agent/acme").main).toBe("twigg-agent/acme");
    expect(agentNamespaces("twigg-agent").main).toBe("twigg-agent");
  });

  it("only strips a whole leading segment", () => {
    expect(agentNamespaces("twigg-agent-dev").main).toBe("twigg-agent/twigg-agent-dev");
  });
});
