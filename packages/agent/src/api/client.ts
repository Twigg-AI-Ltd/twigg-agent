// HTTP client for the Twigg API, implementing the TwiggClient contract.

import { type Turn, type TwiggClient, TwiggError } from "../core/client.js";
import { parseSse } from "./sse.js";
import { TurnAssembler } from "./turn.js";
import type { CatalogueModel, ChatCreated, HistoryPageResponse, RunInspection } from "./types.js";

export interface TwiggClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Wait used between retries; injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

export function createTwiggClient(opts: TwiggClientOptions): TwiggClient {
  const base = `${(opts.baseUrl ?? "https://api.twigg.ai").replace(/\/+$/, "")}/api/v1`;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? defaultSleep;

  async function send(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: "application/json, text/event-stream",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new TwiggError(0, "network_error", errorMessage(err));
    }
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await send(method, path, body);
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  return {
    createChat: (req) => json<ChatCreated>("POST", "/chats", req),

    async respond(chatId, req, { signal, observer } = {}): Promise<Turn> {
      const body = { ...req, idempotency_key: req.idempotency_key ?? crypto.randomUUID() };
      const path = `/chats/${encodeURIComponent(chatId)}/responses`;
      let res: Response;
      for (let attempt = 0; ; attempt++) {
        res = await send("POST", path, body, signal);
        if (res.ok) break;
        if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
          await res.body?.cancel().catch(() => {});
          await sleep(retryDelay(res, attempt), signal);
          continue;
        }
        throw await toError(res);
      }
      if (!res.body) throw new TwiggError(res.status, "empty_stream", "response had no body");

      const assembler = new TurnAssembler(observer);
      try {
        for await (const frame of parseSse(res.body)) {
          assembler.push(frame);
          if (assembler.finished) break;
        }
      } catch (err) {
        if (signal?.aborted || !assembler.turn.runId) throw err;
        // The run continues server-side; keep the runId so the caller can recover via getRun.
        assembler.fail({ code: "stream_interrupted", message: errorMessage(err) });
      }
      assembler.fail({ code: "stream_incomplete", message: "stream ended before done or error" });
      return assembler.turn;
    },

    getRun: (runId) => json<RunInspection>("GET", `/runs/${encodeURIComponent(runId)}`),

    getHistory(chatId, query = {}) {
      const params = new URLSearchParams();
      if (query.beforeOrdinal !== undefined)
        params.set("before_ordinal", String(query.beforeOrdinal));
      if (query.afterOrdinal !== undefined) params.set("after_ordinal", String(query.afterOrdinal));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const qs = params.size > 0 ? `?${params}` : "";
      return json<HistoryPageResponse>("GET", `/chats/${encodeURIComponent(chatId)}/history${qs}`);
    },

    async listModelNames() {
      const models = await json<CatalogueModel[]>("GET", "/models");
      return models.map((m) => m.name);
    },
  };
}

async function toError(res: Response): Promise<TwiggError> {
  const text = await res.text().catch(() => "");
  try {
    const env = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    const e = env.error;
    if (e && typeof e.code === "string" && typeof e.message === "string") {
      return new TwiggError(res.status, e.code, e.message, e.details);
    }
  } catch {
    // Not a JSON envelope.
  }
  return new TwiggError(res.status, `http_${res.status}`, text || res.statusText || "HTTP error");
}

function retryDelay(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 0), MAX_DELAY_MS);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_DELAY_MS);
  }
  const exp = BASE_DELAY_MS * 2 ** attempt;
  return Math.min(exp + Math.random() * exp, MAX_DELAY_MS);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
