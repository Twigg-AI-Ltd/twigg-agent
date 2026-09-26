import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webFetchTool } from "../../src/tools/web-fetch.js";
import { makeCtx, perms } from "./helpers.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<html><head><style>body{}</style><script>alert(1)</script></head>" +
          "<body><h1>Title</h1><p>Hello <a href='/x'>link</a></p></body></html>",
      );
    } else if (req.url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"a":1}');
    } else if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("y".repeat(60_000));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const ctx = () => makeCtx("/");

describe("web_fetch", () => {
  it("converts HTML to markdown without scripts or styles", async () => {
    const out = await webFetchTool.run({ url: `${base}/page` }, ctx());
    expect(out.isError).toBe(false);
    expect(out.text).toContain("# Title");
    expect(out.text).toContain("Hello [link](/x)");
    expect(out.text).not.toContain("alert");
    expect(out.text).not.toContain("body{}");
  });

  it("passes JSON through and caps long bodies", async () => {
    expect((await webFetchTool.run({ url: `${base}/json` }, ctx())).text).toBe('{"a":1}');
    const big = await webFetchTool.run({ url: `${base}/big` }, ctx());
    expect(big.text).toContain("[Truncated: 10000 more characters.]");
  });

  it("reports non-2xx as errors with the status", async () => {
    const out = await webFetchTool.run({ url: `${base}/missing` }, ctx());
    expect(out.isError).toBe(true);
    expect(out.text).toContain("HTTP 404");
  });

  it("rejects non-http URLs and is blocked without network", async () => {
    expect((await webFetchTool.run({ url: "file:///etc/passwd" }, ctx())).isError).toBe(true);
    const out = await webFetchTool.run(
      { url: `${base}/page` },
      makeCtx("/", { permissions: perms({ network: false }) }),
    );
    expect(out.blocked).toBe(true);
    expect(out.text).toContain(`fetch ${base}/page`);
  });
});
