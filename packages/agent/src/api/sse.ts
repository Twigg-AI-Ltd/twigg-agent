// Server-sent events parser (https://html.spec.whatwg.org/multipage/server-sent-events.html).

export interface SseFrame {
  event: string;
  data: string;
}

/** Parse a byte stream into SSE frames. Robust to arbitrary chunk boundaries. */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];

  function* flushLines(final: boolean): Generator<SseFrame> {
    let start = 0;
    while (start < buffer.length) {
      const cr = buffer.indexOf("\r", start);
      const lf = buffer.indexOf("\n", start);
      let end: number;
      if (cr === -1 && lf === -1) break;
      if (cr === -1) end = lf;
      else if (lf === -1) end = cr;
      else end = Math.min(cr, lf);
      let next = end + 1;
      if (buffer[end] === "\r") {
        // A trailing \r may be the first half of \r\n split across chunks.
        if (end === buffer.length - 1 && !final) break;
        if (buffer[end + 1] === "\n") next = end + 2;
      }
      const frame = processLine(buffer.slice(start, end));
      if (frame) yield frame;
      start = next;
    }
    buffer = buffer.slice(start);
  }

  function processLine(line: string): SseFrame | undefined {
    if (line === "") {
      if (data.length === 0) {
        event = "";
        return undefined;
      }
      const frame = { event: event || "message", data: data.join("\n") };
      event = "";
      data = [];
      return frame;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return undefined;
  }

  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      yield* flushLines(false);
    }
    buffer += decoder.decode();
    yield* flushLines(true);
    // Lenient: dispatch a final event even if the stream ended without a blank line.
    if (buffer !== "") {
      const frame = processLine(buffer);
      buffer = "";
      if (frame) yield frame;
    }
    const last = processLine("");
    if (last) yield last;
  } finally {
    // Consumer stopped early or reading failed: close the connection.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
