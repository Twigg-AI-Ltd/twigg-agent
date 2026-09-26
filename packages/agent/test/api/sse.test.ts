import { describe, expect, it } from "vitest";
import { parseSse, type SseFrame } from "../../src/api/sse.js";
import { chunked, FIXTURES, fixture, randomSizes } from "./helpers.js";

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of parseSse(stream)) out.push(f);
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("parseSse", () => {
  for (const name of FIXTURES) {
    it(`parses ${name} identically across chunk boundaries`, async () => {
      const bytes = fixture(`sse/${name}.sse`);
      const whole = await collect(chunked(bytes));
      expect(whole[0]?.event).toBe("run");
      expect(whole.at(-1)?.event).toBe("done");
      for (const d of whole) expect(() => JSON.parse(d.data)).not.toThrow();
      for (let seed = 1; seed <= 20; seed++) {
        expect(await collect(chunked(bytes, randomSizes(seed)))).toEqual(whole);
      }
      expect(await collect(chunked(bytes, [1]))).toEqual(whole);
    });
  }

  it("handles multi-byte characters split across chunks", async () => {
    const bytes = enc('event: delta\ndata: {"text":"héllo 🌳 wörld"}\n\n');
    const expected = [{ event: "delta", data: '{"text":"héllo 🌳 wörld"}' }];
    for (let size = 1; size <= 5; size++) {
      expect(await collect(chunked(bytes, [size]))).toEqual(expected);
    }
  });

  it("handles CRLF (split between chunks), CR, multi-line data and comments", async () => {
    const text =
      ": keepalive\r\nevent: a\r\ndata: one\r\ndata:two\r\n\r\n" +
      "data: plain\r\rid: 5\nretry: 10\nevent: b\ndata\n\n\n";
    const expected = [
      { event: "a", data: "one\ntwo" },
      { event: "message", data: "plain" },
      { event: "b", data: "" },
    ];
    for (let size = 1; size <= 4; size++) {
      expect(await collect(chunked(enc(text), [size]))).toEqual(expected);
    }
  });

  it("dispatches a final event without a trailing blank line", async () => {
    expect(await collect(chunked(enc("event: x\ndata: 1")))).toEqual([{ event: "x", data: "1" }]);
  });
});
