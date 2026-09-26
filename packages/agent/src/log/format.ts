import type { LogEvent } from "../core/types.js";

const MAX = 120;

/** One line, whitespace collapsed, truncated to `max` chars with an ellipsis. */
export function oneLine(text: string, max = MAX): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `850ms`, `1.2s`, `1m12s`, `1h03m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------------------------

export interface HumanOptions {
  /** Emit ANSI colours. */
  color?: boolean;
  /** Terminal width used to wrap prose; unset means no wrapping. */
  width?: number;
}

type Style = "dim" | "bold" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan";

const SGR: Record<Style, [number, number]> = {
  dim: [2, 22],
  bold: [1, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
};

type Paint = (style: Style, text: string) => string;

const paintWith =
  (color: boolean): Paint =>
  (style, text) => {
    if (!color || !text) return text;
    const [on, off] = SGR[style];
    return `\x1b[${on}m${text}\x1b[${off}m`;
  };

// ---------------------------------------------------------------------------------------------
// Body text
// ---------------------------------------------------------------------------------------------

/** Tool output can carry colour codes, carriage returns and other controls that garble a log. */
function clean(text: string): string[] {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes.
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .split("\n")
      .map((l) => l.trimEnd())
  );
}

/** Drops leading/trailing blank lines and squeezes runs of blank lines to one. */
function tidy(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (!l && (!out.length || !out[out.length - 1])) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

function wrap(line: string, width: number | undefined): string[] {
  if (!width || line.length <= width) return [line];
  const indent = /^\s*(?:[-*•]\s+|\d+[.)]\s+)?/.exec(line)?.[0].length ?? 0;
  const pad = " ".repeat(Math.min(indent, 8));
  const out: string[] = [];
  let cur = "";
  for (const word of line.slice(indent).split(/ +/)) {
    const prefix = out.length ? pad : line.slice(0, indent);
    if (cur && prefix.length + cur.length + 1 + word.length > width) {
      out.push(prefix + cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  out.push((out.length ? pad : line.slice(0, indent)) + cur);
  return out;
}

interface BodyOptions {
  maxLines: number;
  /** Wrap prose at the width; otherwise cut long lines (for code and command output). */
  prose: boolean;
  style?: Style;
}

function body(text: string, o: BodyOptions, h: HumanOptions, paint: Paint): string[] {
  const width = h.width ? Math.max(h.width - INDENT.length, 40) : undefined;
  const lines = tidy(clean(text)).flatMap((l) =>
    o.prose
      ? wrap(l, width)
      : [l.length > (width ?? 200) ? `${l.slice(0, (width ?? 200) - 1)}…` : l],
  );
  const shown = lines.length > o.maxLines ? lines.slice(0, o.maxLines) : lines;
  const out = shown.map((l) => (o.style ? paint(o.style, l) : l));
  if (lines.length > shown.length) {
    out.push(paint("dim", `… ${lines.length - shown.length} more lines`));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/** Continuation lines line up under the text after `HH:MM:SS `. */
const INDENT = "         ";

const KEY_FIELDS = ["command", "path", "file_path", "url", "pattern", "query", "task", "model"];

/** Compact one-line view of tool input: the most telling field, else `key=value` pairs. */
function summarizeInput(input: unknown): string {
  if (typeof input === "string") return oneLine(input);
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    const key = KEY_FIELDS.find((k) => typeof rec[k] === "string");
    if (key) return oneLine(rec[key] as string);
    const pairs = Object.entries(rec)
      .filter(([, v]) => v !== null && v !== undefined && v !== "" && !isEmptyArray(v))
      .map(([k, v]) => `${k}=${inputValue(v)}`);
    return oneLine(pairs.join(" "));
  }
  return oneLine(JSON.stringify(input) ?? "");
}

function isEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length === 0;
}

/** Strings bare (quoted when they contain spaces), scalar arrays comma-joined, the rest JSON. */
function inputValue(v: unknown): string {
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  if (Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null)) {
    return v.map((x) => inputValue(x)).join(",");
  }
  return JSON.stringify(v) ?? String(v);
}

/** The todo event already shows the checklist, so its call and plain result add nothing. */
function redundant(event: LogEvent): boolean {
  return (
    (event.type === "tool_call" && event.tool === "todo") ||
    (event.type === "tool_result" && event.tool === "todo" && !event.isError)
  );
}

const usd = (n: number, digits = 4) => `$${n.toFixed(digits)}`;

/** Head line plus optional indented body lines. */
type Rendered = [head: string, body?: string[]];

function describe(event: LogEvent, h: HumanOptions, p: Paint): Rendered {
  switch (event.type) {
    case "run_start":
      return [
        `${p("bold", "▶ run")}  ${p("cyan", event.model)}  ${p("dim", `ns=${event.namespace}  instructions=${event.instructionsPath}`)}`,
      ];
    case "config_notice":
      // Harness messages to the user: shown in full, never clipped like tool output.
      return [`${p("blue", "ℹ config")}  ${oneLine(event.message, 1_000)}`];
    case "turn_start":
      return [p("dim", `── turn ${event.turn} · ${event.model} ──`)];
    case "assistant_text":
      return [p("magenta", "» assistant"), body(event.text, { maxLines: 40, prose: true }, h, p)];
    case "tool_call":
      return [`${p("cyan", `→ ${event.tool}`)}  ${summarizeInput(event.input)}`];
    case "tool_result": {
      if (event.blocked) {
        return [
          `${p("red", `✗ ${event.tool}  BLOCKED`)}`,
          body(event.preview, { maxLines: 6, prose: false, style: "red" }, h, p),
        ];
      }
      const ok = !event.isError;
      const head = ok
        ? `${p("green", `← ${event.tool}`)}  ${p("dim", `ok ${formatDuration(event.durationMs)}`)}`
        : `${p("red", `✗ ${event.tool}  error`)}  ${p("dim", formatDuration(event.durationMs))}`;
      return [
        head,
        body(event.preview, { maxLines: ok ? 3 : 10, prose: false, style: "dim" }, h, p),
      ];
    }
    case "todo":
      return [
        p("blue", "☰ todo"),
        event.items.map((i) =>
          i.done ? p("dim", `☑ ${oneLine(i.text, 200)}`) : `☐ ${oneLine(i.text, 200)}`,
        ),
      ];
    case "twigg_warning":
      return [`${p("yellow", `⚠ twigg ${event.code}`)}  ${oneLine(event.message)}`];
    case "compacting":
      return [p("dim", "⟳ compacting context")];
    case "limit_warning": {
      const fmt =
        event.limit === "cost"
          ? (n: number) => usd(n, 2)
          : event.limit === "time"
            ? formatDuration
            : String;
      return [
        p(
          "yellow",
          `⚠ limit ${event.limit} ${fmt(event.used)}/${fmt(event.max)} — agent told to wrap up`,
        ),
      ];
    }
    case "progress": {
      const t = event.tokens;
      return [
        p(
          "dim",
          `Σ turn ${event.turns}  tokens in ${tokens(t.input)} out ${tokens(t.output)}  cost ${usd(event.costUsd)}  elapsed ${formatDuration(event.elapsedMs)}`,
        ),
      ];
    }
    case "model_fallback":
      return [`${p("yellow", `↪ fallback ${event.from} → ${event.to}`)}  ${oneLine(event.reason)}`];
    case "subagent_start":
      return [
        `${p("bold", "⇢ subagent start")}  ${p("cyan", event.model)}`,
        body(event.task, { maxLines: 8, prose: true }, h, p),
      ];
    case "subagent_finish": {
      const color = event.status === "success" ? "green" : "red";
      return [
        p(color, `⇠ subagent ${event.status}`),
        body(event.summary, { maxLines: 20, prose: true }, h, p),
      ];
    }
    case "run_finish": {
      const r = event.result;
      const ok = r.status === "success";
      const detail = r.limitHit ? ` (${r.limitHit} limit)` : "";
      const stats = `turns ${r.turns} · ${usd(r.costUsd)} · ${formatDuration(r.durationMs)}`;
      const lines = body(r.summary || r.reason, { maxLines: 200, prose: true }, h, p);
      if (!ok && r.summary && r.reason) lines.push("", `reason: ${r.reason}`);
      for (const q of r.clarifications) lines.push(`? ${q}`);
      return [
        `${p(ok ? "green" : "red", `${p("bold", ok ? "✔ finish" : "✗ finish")} ${r.status}${detail}`)}  ${p("dim", stats)}`,
        lines,
      ];
    }
    case "error":
      return [
        p("red", "✗ error"),
        body(event.message, { maxLines: 20, prose: false, style: "red" }, h, p),
      ];
  }
}

/** Blank line before these, so each turn and the final result stand apart. */
const SPACED = new Set<LogEvent["type"]>(["turn_start", "run_finish"]);

/**
 * Human view of an event: `HH:MM:SS [sub-N] <head>`, then any body lines indented under the head.
 * Never ends with a newline. Empty for events the human view leaves out.
 */
export function formatHuman(event: LogEvent, now = new Date(), opts: HumanOptions = {}): string {
  if (redundant(event)) return "";
  const p = paintWith(opts.color ?? false);
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const agentId = "agentId" in event ? event.agentId : undefined;
  const tag = agentId && agentId !== "main" ? `${p("yellow", `[${agentId}]`)} ` : "";
  const indent = agentId && agentId !== "main" ? `${INDENT}  ` : INDENT;
  const [head, lines = []] = describe(event, opts, p);
  const out = [`${p("dim", time)} ${tag}${head}`, ...lines.map((l) => (l ? `${indent}${l}` : ""))];
  return (SPACED.has(event.type) ? "\n" : "") + out.join("\n");
}
