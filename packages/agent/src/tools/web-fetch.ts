import TurndownService from "turndown";
import * as s from "../core/schema.js";
import { blockedOutput } from "../permissions/index.js";
import { defineTool, fail, ok } from "./util.js";

const MAX_CHARS = 50_000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|[\w.+-]+\+(json|xml)))/;

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  td.remove(["script", "style", "noscript"]);
  return td.turndown(html);
}

export const webFetchTool = defineTool({
  name: "web_fetch",
  description:
    "Fetch a URL over HTTP(S). HTML is converted to markdown; JSON and text are returned as-is. " +
    `Output is capped at ${MAX_CHARS} characters.`,
  schema: s.object({
    url: s.string({ min: 1 }).describe("http:// or https:// URL."),
  }),
  async run(input, ctx) {
    if (!ctx.permissions.network) return blockedOutput(`fetch ${input.url}`);
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return fail(`Invalid URL: ${input.url}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fail(`Only http and https URLs are supported, got ${url.protocol}`);
    }

    const res = await fetch(url, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]),
      headers: { accept: "text/html, application/json, text/*;q=0.9, */*;q=0.5" },
    });
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const isText = type === "" || TEXT_TYPES.test(type);
    if (!res.ok) {
      const body = isText ? (await res.text()).slice(0, 2000) : "";
      return fail(`HTTP ${res.status} ${res.statusText} for ${url}${body ? `\n\n${body}` : ""}`);
    }
    if (!isText) {
      await res.body?.cancel();
      return fail(`Unsupported content type "${type}" for ${url}.`);
    }

    const body = await res.text();
    let text = type.includes("html") ? htmlToMarkdown(body) : body;
    if (text.length > MAX_CHARS) {
      text = `${text.slice(0, MAX_CHARS)}\n\n[Truncated: ${text.length - MAX_CHARS} more characters.]`;
    }
    return ok(text || "(empty response)");
  },
});
