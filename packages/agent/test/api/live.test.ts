// Live smoke test against the real Twigg API. Run with TWIGG_LIVE=1 and TWIGG_API_KEY set.
import { describe, expect, it } from "vitest";
import { createTwiggClient } from "../../src/api/client.js";

const live = process.env.TWIGG_LIVE === "1";

describe.skipIf(!live)("live Twigg API", () => {
  it("creates a chat and completes a turn", { timeout: 60_000 }, async () => {
    const apiKey = process.env.TWIGG_API_KEY;
    if (!apiKey) throw new Error("TWIGG_API_KEY is not set");
    const client = createTwiggClient({ apiKey });

    const models = await client.listModelNames();
    expect(models).toContain("gpt-6-luna");

    const chat = await client.createChat({ namespace: "twigg-agent-dev/tests" });
    const turn = await client.respond(chat.id, {
      model: "gpt-6-luna",
      input: [{ type: "prompt", text: "Reply with the single word: pong" }],
      max_tokens: 200,
    });
    expect(turn.error).toBeUndefined();
    expect(turn.chatId).toBe(chat.id);
    expect(turn.runId).not.toBe("");
    expect(turn.done?.stopReason).toBe("end_turn");
    expect(turn.text.toLowerCase()).toContain("pong");
  });
});
