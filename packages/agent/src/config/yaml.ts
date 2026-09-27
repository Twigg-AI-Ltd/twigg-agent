// A reader for the part of YAML that frontmatter uses: mappings and lists, written as indented
// blocks or inline ({...}, [...], which covers JSON), holding strings, numbers, booleans and null.
// Anything else (anchors, tags, multi-line strings) is an error that names the line, never a guess.

interface Line {
  /** 1-based, counted from the first line of the text. */
  no: number;
  indent: number;
  text: string;
}

class YamlError extends Error {
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
  }
}

/** The line without its comment and trailing spaces. */
function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if ((c === "\\" && quote === '"') || (c === "'" && quote === "'" && line[i + 1] === "'")) i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      // A quote only opens a string at the start of a value.
      if (i === 0 || /[\s[{,:]/.test(line[i - 1] as string)) quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function plainScalar(text: string, line: number): unknown {
  if (text === "" || text === "~" || /^(null|Null|NULL)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  if (/^0x[0-9a-fA-F]+$/.test(text) || /^0o[0-7]+$/.test(text)) return Number(text);
  if (/^[-+]?\.(inf|nan)$/i.test(text)) throw new YamlError(line, `${text} is not supported`);
  if (/^[&*!|>%@`?]/.test(text) || /^-(\s|$)/.test(text)) {
    throw new YamlError(line, `"${text[0]}" is not supported here; put the value in quotes`);
  }
  if (/:\s/.test(text) || text.endsWith(":")) {
    throw new YamlError(line, 'a value containing ": " must be in quotes');
  }
  return text;
}

/** Reads inline values from `text`, starting at `pos`. */
class Inline {
  pos = 0;

  constructor(
    readonly text: string,
    readonly line: number,
  ) {}

  private skipSpaces(): void {
    while (/\s/.test(this.text[this.pos] ?? "")) this.pos++;
  }

  /** True when only spaces remain. */
  atEnd(): boolean {
    this.skipSpaces();
    return this.pos >= this.text.length;
  }

  private fail(message: string): never {
    throw new YamlError(this.line, message);
  }

  private oneLine(text: string): string {
    if (text.includes("\n")) this.fail("a value can't continue on the next line");
    return text;
  }

  /** A quoted string starting at `pos`, which is left after the closing quote. */
  quoted(): string {
    const quote = this.text[this.pos] as string;
    let end = this.pos + 1;
    for (; end < this.text.length; end++) {
      const c = this.text[end];
      if (quote === '"' && c === "\\") end++;
      else if (c === quote) {
        // In single quotes, '' is a quote character.
        if (quote === "'" && this.text[end + 1] === "'") end++;
        else break;
      }
    }
    if (end >= this.text.length) this.fail(`missing closing ${quote}`);
    const body = this.oneLine(this.text.slice(this.pos + 1, end));
    this.pos = end + 1;
    if (quote === "'") return body.replaceAll("''", "'");
    try {
      return JSON.parse(`"${body.replaceAll("\t", "\\t")}"`) as string;
    } catch {
      return this.fail(`invalid escape in "${body}"`);
    }
  }

  /** A value; `stops` are the characters that end a plain one. */
  value(stops: string): unknown {
    this.skipSpaces();
    const c = this.text[this.pos];
    if (c === "[") return this.list();
    if (c === "{") return this.map();
    if (c === '"' || c === "'") return this.quoted();
    const start = this.pos;
    while (this.pos < this.text.length && !stops.includes(this.text[this.pos] as string)) {
      this.pos++;
    }
    return plainScalar(this.oneLine(this.text.slice(start, this.pos).trim()), this.line);
  }

  private list(): unknown[] {
    const out: unknown[] = [];
    this.pos++;
    for (;;) {
      if (this.atEnd()) this.fail("missing closing ]");
      if (this.text[this.pos] === "]") break;
      out.push(this.value(",]"));
      this.skipSpaces();
      if (this.text[this.pos] === ",") this.pos++;
      else if (this.atEnd()) this.fail("missing closing ]");
      else if (this.text[this.pos] !== "]") this.fail("expected , or ] in the list");
    }
    this.pos++;
    return out;
  }

  private map(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.pos++;
    for (;;) {
      if (this.atEnd()) this.fail("missing closing }");
      if (this.text[this.pos] === "}") break;
      const c = this.text[this.pos];
      let key: string;
      if (c === '"' || c === "'") key = this.quoted();
      else {
        const start = this.pos;
        while (this.pos < this.text.length && !":,}".includes(this.text[this.pos] as string)) {
          this.pos++;
        }
        key = this.oneLine(this.text.slice(start, this.pos).trim());
      }
      if (this.atEnd()) this.fail("missing closing }");
      if (key === "" || this.text[this.pos] !== ":")
        this.fail("expected key: value in the mapping");
      this.pos++;
      setKey(out, key, this.value(",}"), this.line);
      this.skipSpaces();
      if (this.text[this.pos] === ",") this.pos++;
      else if (this.atEnd()) this.fail("missing closing }");
      else if (this.text[this.pos] !== "}") this.fail("expected , or } in the mapping");
    }
    this.pos++;
    return out;
  }
}

function setKey(map: Record<string, unknown>, key: string, value: unknown, line: number): void {
  if (Object.hasOwn(map, key)) throw new YamlError(line, `the key "${key}" is there twice`);
  // Not a plain assignment, so that a key named __proto__ is a key like any other.
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Splits `key: rest`. Undefined when the text isn't a mapping entry. */
function splitEntry(text: string, line: number): { key: string; rest: string } | undefined {
  if (text[0] === '"' || text[0] === "'") {
    const inline = new Inline(text, line);
    const key = inline.quoted();
    const after = text.slice(inline.pos);
    return /^\s*:(\s|$)/.test(after) ? { key, rest: after.replace(/^\s*:\s*/, "") } : undefined;
  }
  const m = /^([^\s:#[\]{},&*!|>'"%@`-][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s+(.*))?$/.exec(text);
  return m ? { key: m[1] as string, rest: m[2] ?? "" } : undefined;
}

class Blocks {
  private at = 0;

  constructor(private readonly lines: Line[]) {}

  parse(): unknown {
    const first = this.lines[0];
    if (!first) return null;
    const value = this.block(first.indent);
    const extra = this.lines[this.at];
    if (extra) throw new YamlError(extra.no, `unexpected "${extra.text}"`);
    return value;
  }

  private block(indent: number): unknown {
    const line = this.lines[this.at] as Line;
    if (isItem(line.text)) return this.list(indent);
    if (splitEntry(line.text, line.no)) return this.map(indent);
    this.at++;
    return this.inline(line.text, line);
  }

  /** An inline value, which may continue over the following lines until its brackets close. */
  private inline(text: string, line: Line): unknown {
    let source = text;
    for (;;) {
      const inline = new Inline(source, line.no);
      try {
        const value = inline.value("");
        if (!inline.atEnd()) {
          throw new YamlError(line.no, `unexpected "${source.slice(inline.pos).trim()}"`);
        }
        return value;
      } catch (err) {
        const next = this.lines[this.at];
        const unclosed = err instanceof YamlError && err.message.includes("missing closing");
        if (!unclosed || !next || !/^[[{]/.test(text)) throw err;
        source += `\n${next.text}`;
        this.at++;
      }
    }
  }

  /** The value after `key:` or `-`: inline, or a block on the lines below. */
  private valueAfter(rest: string, line: Line, indent: number, inList: boolean): unknown {
    if (rest !== "") return this.inline(rest, line);
    const next = this.lines[this.at];
    if (!next) return null;
    if (next.indent > indent) return this.block(next.indent);
    // A list may sit at the same indentation as the key it belongs to.
    if (!inList && next.indent === indent && isItem(next.text)) return this.list(indent);
    return null;
  }

  private map(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (
      let line = this.lines[this.at];
      line && line.indent >= indent;
      line = this.lines[this.at]
    ) {
      if (line.indent > indent) throw new YamlError(line.no, "unexpected indentation");
      const entry = splitEntry(line.text, line.no);
      if (!entry) throw new YamlError(line.no, `expected "key: value", got "${line.text}"`);
      this.at++;
      setKey(out, entry.key, this.valueAfter(entry.rest, line, indent, false), line.no);
    }
    return out;
  }

  private list(indent: number): unknown[] {
    const out: unknown[] = [];
    for (
      let line = this.lines[this.at];
      line && line.indent >= indent;
      line = this.lines[this.at]
    ) {
      if (line.indent > indent) throw new YamlError(line.no, "unexpected indentation");
      // Anything else ends the list; what it is, is for the enclosing block to say.
      if (!isItem(line.text)) break;
      const rest = line.text.slice(1).trimStart();
      if (rest !== "" && (isItem(rest) || splitEntry(rest, line.no))) {
        // "- key: value" starts a block of its own, indented to where the key is.
        const inner = indent + (line.text.length - rest.length);
        this.lines[this.at] = { no: line.no, indent: inner, text: rest };
        out.push(this.block(inner));
        continue;
      }
      this.at++;
      out.push(this.valueAfter(rest, line, indent, true));
    }
    return out;
  }
}

function isItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** Parses the text. Throws an Error whose message names the line when it can't. */
export function parseYaml(text: string): unknown {
  const lines: Line[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const content = stripComment(raw);
    const body = content.trimStart();
    if (body === "") continue;
    const no = i + 1;
    if (/^\s*\t/.test(content)) throw new YamlError(no, "indent with spaces, not tabs");
    if (/^(---|\.\.\.)(\s|$)/.test(content)) {
      throw new YamlError(no, "only one document is supported");
    }
    lines.push({ no, indent: content.length - body.length, text: body });
  }
  return new Blocks(lines).parse();
}
