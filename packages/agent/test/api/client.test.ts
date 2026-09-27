import { describe, expect, it } from "vitest";
import { createTwiggClient } from "../../src/api/client.js";
import { TwiggError } from "../../src/core/client.js";
import { chunked, fixture } from "./helpers.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake fetch answering from a queue of responses (or errors to throw). */
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fn as typeof fetch, calls };
}

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const sseRes = (name: string) =>
  new Response(chunked(fixture(`sse/${name}.sse`), [13]), {
    headers: { "Content-Type": "text/event-stream" },
  });
const unavailable = (headers: Record<string, string> = {}) =>
  jsonRes({ error: { code: "unavailable", message: "busy" } }, 503, headers);

function client(responses: (Response | Error)[]) {
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const c = createTwiggClient({
    apiKey: "k",
    baseUrl: "https://example.test/",
    fetch: f.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { c, calls: f.calls, sleeps };
}

const req = { model: "m", input: [{ type: "prompt" as const, text: "hi" }] };

describe("createTwiggClient", () => {
  it("respond streams a turn with auth and a generated idempotency key", async () => {
    const { c, calls } = client([sseRes("tool-call-args")]);
    const t = await c.respond("chat/1", req);
    expect(t.toolCalls[0]?.input).toEqual({ content: "hi there", path: "notes/a.txt" });
    expect(t.done?.stopReason).toBe("tool_use");
    expect(calls[0]?.url).toBe("https://example.test/api/v1/chats/chat%2F1/responses");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.Authorization).toBe("Bearer k");
    expect(calls[0]?.body).toMatchObject({ model: "m", idempotency_key: expect.any(String) });
  });

  it("parses a pre-stream error envelope into TwiggError", async () => {
    const body = new TextDecoder().decode(fixture("error-404-envelope.json"));
    const { c } = client([new Response(body, { status: 404 })]);
    const err = await c.respond("c", req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TwiggError);
    expect(err).toMatchObject({
      status: 404,
      code: "not_found",
      message: "unknown or withdrawn model 'no-such-model'",
    });
  });

  it("maps non-envelope errors and network failures", async () => {
    const { c } = client([new Response("oops", { status: 500 }), new TypeError("fetch failed")]);
    await expect(c.getRun("r")).rejects.toMatchObject({ status: 500, code: "http_500" });
    const err = await c.getRun("r").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: "network_error", isProviderFailure: true });
  });

  it("retries 503/429 with the same body and key, honouring Retry-After", async () => {
    const { c, calls, sleeps } = client([
      unavailable({ "Retry-After": "2" }),
      jsonRes({ error: { code: "rate_limited", message: "slow" } }, 429),
      sseRes("text-only"),
    ]);
    const t = await c.respond("c", { ...req, idempotency_key: "key-1" });
    expect(t.text).toBe("Hello there, how are you?");
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.body).toEqual({ ...req, idempotency_key: "key-1" });
    expect(sleeps[0]).toBe(2000);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[1]).toBeLessThan(2000);
  });

  it("reuses a generated key across retries and gives up after 3 retries", async () => {
    const { c, calls } = client([unavailable(), unavailable(), unavailable(), unavailable()]);
    await expect(c.respond("c", req)).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(calls).toHaveLength(4);
    const keys = new Set(calls.map((x) => (x.body as { idempotency_key: string }).idempotency_key));
    expect(keys.size).toBe(1);
  });

  it("does not retry other errors", async () => {
    const { c, calls } = client([jsonRes({ error: { code: "conflict", message: "x" } }, 409)]);
    await expect(c.respond("c", req)).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
  });

  it("returns stream_incomplete when the stream ends early", async () => {
    const sse = 'event: run\ndata: {"run_id":"r","chat_id":"c","closed_tool_calls":[]}\n\n';
    const { c } = client([new Response(sse)]);
    const t = await c.respond("c", req);
    expect(t.runId).toBe("r");
    expect(t.error?.code).toBe("stream_incomplete");
  });

  it("listModels, listModelNames, getHistory, createChat", async () => {
    const { c, calls } = client([
      jsonRes([{ name: "gpt-6-luna", rates: { input: "0.1" } }]),
      jsonRes([{ name: "gpt-6-luna" }, { name: "claude-sonnet-5" }]),
      jsonRes({ parts: [] }),
      jsonRes({ id: "chat" }),
    ]);
    expect(await c.listModels()).toEqual([{ name: "gpt-6-luna", rates: { input: "0.1" } }]);
    expect(calls[0]?.url).toBe("https://example.test/api/v1/models");
    expect(await c.listModelNames()).toEqual(["gpt-6-luna", "claude-sonnet-5"]);
    await c.getHistory("c", { beforeOrdinal: 5, limit: 10 });
    expect(calls[2]?.url).toBe(
      "https://example.test/api/v1/chats/c/history?before_ordinal=5&limit=10",
    );
    await c.createChat({ namespace: "a/b" });
    expect(calls[3]).toMatchObject({ method: "POST", body: { namespace: "a/b" } });
  });
});
