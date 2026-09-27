// HTML to markdown, for web_fetch. Reads real-world HTML leniently (unclosed tags, missing quotes)
// and keeps what a reader needs: headings, paragraphs, links, lists, quotes, code and tables.

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = Element | string;

const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
/** Elements whose content is text up to their closing tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp"]);
/** Elements left out of the output along with everything inside them. */
const SKIPPED = new Set(
  (
    "head script style noscript template svg math iframe object embed canvas audio video " +
    "select input textarea"
  ).split(" "),
);
const BLOCKS = new Set(
  (
    "address article aside blockquote body details dd div dl dt fieldset figcaption figure " +
    "footer form h1 h2 h3 h4 h5 h6 header hr html li main nav ol p pre section summary table ul"
  ).split(" "),
);
/** An opening tag closes these open elements, looking no further up than the listed ancestors. */
const IMPLIED_END: Record<string, { close: string[]; within: string[] }> = {
  li: { close: ["li"], within: ["ul", "ol"] },
  dt: { close: ["dt", "dd"], within: ["dl"] },
  dd: { close: ["dt", "dd"], within: ["dl"] },
  thead: { close: ["thead", "tbody", "tfoot", "tr", "td", "th"], within: ["table"] },
  tbody: { close: ["thead", "tbody", "tfoot", "tr", "td", "th"], within: ["table"] },
  tfoot: { close: ["thead", "tbody", "tfoot", "tr", "td", "th"], within: ["table"] },
  tr: { close: ["tr", "td", "th"], within: ["table"] },
  td: { close: ["td", "th"], within: ["tr", "table"] },
  th: { close: ["td", "th"], within: ["tr", "table"] },
  option: { close: ["option"], within: ["select"] },
};

/** Content that a cell of a data table doesn't hold. */
const LAYOUT_CONTENT = "table ul ol pre blockquote h1 h2 h3 h4 h5 h6".split(" ");

/** Deepest nesting that is kept, so that a hostile page can't exhaust the stack. */
const MAX_DEPTH = 256;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  times: "×",
  euro: "€",
  pound: "£",
  deg: "°",
  larr: "←",
  rarr: "→",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
    if (name[0] !== "#") return ENTITIES[name] ?? whole;
    const code = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(ATTRIBUTE)) {
    const name = (m[1] as string).toLowerCase();
    attrs[name] ??= decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Parses HTML into a tree. Never throws: anything it can't read as markup is kept as text. */
export function parseHtml(html: string): Element {
  const root: Element = { tag: "#root", attrs: {}, children: [] };
  const open: Element[] = [root];
  const top = () => open[open.length - 1] as Element;
  const closeTo = (index: number) => open.splice(Math.max(index, 1));
  const lower = html.toLowerCase();
  // The next ">" at or after `from`, remembered so that a run of stray "<" doesn't search the
  // rest of the page once per "<". -1 means there is none left, which stays true.
  let nextGt = -2;
  const gtFrom = (from: number) => {
    if (nextGt !== -1 && nextGt < from) nextGt = html.indexOf(">", from);
    return nextGt;
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt !== i) {
      const end = lt === -1 ? html.length : lt;
      top().children.push(decodeEntities(html.slice(i, end)));
      i = end;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(html.slice(i, i + 80));
    const gt = gtFrom(i);
    if (!m) {
      // A declaration such as <!doctype> is dropped; a stray "<" is text.
      if (/^<[!?]/.test(html.slice(i, i + 2)) && gt !== -1) i = gt + 1;
      else {
        top().children.push("<");
        i += 1;
      }
      continue;
    }
    if (gt === -1) break;
    const tag = (m[2] as string).toLowerCase();
    const inside = html.slice(i + m[0].length, gt);
    i = gt + 1;

    if (m[1]) {
      const at = open.findLastIndex((el) => el.tag === tag);
      if (at > 0) closeTo(at);
      continue;
    }

    const implied = IMPLIED_END[tag];
    if (implied) {
      let outermost = 0;
      for (let k = open.length - 1; k > 0; k--) {
        const el = open[k] as Element;
        if (implied.within.includes(el.tag)) break;
        if (implied.close.includes(el.tag)) outermost = k;
      }
      if (outermost > 0) closeTo(outermost);
    } else if (BLOCKS.has(tag)) {
      // A paragraph ends where the next block starts.
      const at = open.findLastIndex((el) => el.tag === "p");
      if (at > 0 && !open.slice(at).some((el) => el.tag === "button")) closeTo(at);
    }

    const el: Element = { tag, attrs: parseAttributes(inside), children: [] };
    top().children.push(el);
    if (VOID.has(tag)) continue;
    if (RAW_TEXT.has(tag)) {
      const end = lower.indexOf(`</${tag}`, i);
      const stop = end === -1 ? html.length : end;
      el.children.push(tag === "title" ? decodeEntities(html.slice(i, stop)) : html.slice(i, stop));
      const after = html.indexOf(">", stop);
      i = end === -1 || after === -1 ? html.length : after + 1;
      continue;
    }
    // Past the depth limit, content joins the deepest element that was opened.
    if (open.length < MAX_DEPTH && (!inside.endsWith("/") || BLOCKS.has(tag))) open.push(el);
  }
  return root;
}

function textOf(node: Node): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

/** The first element inside `el` whose tag is one of `tags`. */
function find(el: Element, tags: string[]): Element | undefined {
  for (const child of el.children) {
    if (typeof child === "string") continue;
    const found = tags.includes(child.tag) ? child : find(child, tags);
    if (found) return found;
  }
  return undefined;
}

function isHidden(el: Element): boolean {
  return "hidden" in el.attrs || el.attrs["aria-hidden"] === "true";
}

function withoutTrailingSpaces(text: string): string {
  let end = text.length;
  while (text[end - 1] === " ") end--;
  return text.slice(0, end);
}

/** Joins rendered pieces, dropping the spaces that would start or end a line or follow a space. */
function join(pieces: string[]): string {
  const out: string[] = [];
  let last = "";
  for (let piece of pieces) {
    if (last === "\n" || last === " ") piece = piece.replace(/^ +/, "");
    if (piece === "") continue;
    if (piece[0] === "\n") {
      while (out.length > 0) {
        const kept = withoutTrailingSpaces(out.pop() as string);
        if (kept !== "") {
          out.push(kept);
          break;
        }
      }
    }
    out.push(piece);
    last = piece[piece.length - 1] as string;
  }
  return out.join("");
}

function indent(text: string, prefix: string): string {
  return text.replaceAll("\n", `\n${prefix}`).replace(/[ \t]+$/gm, "");
}

/** Wraps the text in `mark`, keeping the surrounding whitespace outside the marks. */
function wrap(text: string, mark: string): string {
  const core = text.trim();
  if (core === "") return text === "" ? "" : " ";
  const lead = /^\s/.test(text) ? " " : "";
  const trail = /\s$/.test(text) ? " " : "";
  return `${lead}${mark}${core}${mark}${trail}`;
}

class Renderer {
  /** Code blocks are set aside so that tidying whitespace can't touch them. */
  private readonly code: string[] = [];

  constructor(private readonly baseUrl: string | undefined) {}

  render(root: Element): string {
    const title = find(root, ["title"]);
    const text = `${title ? textOf(title).replace(/\s+/g, " ") : ""}\n\n${this.children(root)}`
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text.replace(/\0(\d+)\0/g, (_, n: string) => this.code[Number(n)] as string);
  }

  private children(el: Element): string {
    return join(el.children.map((child) => this.node(child, el)));
  }

  private inline(el: Element): string {
    return this.children(el)
      .replace(/\s*\n\s*/g, " ")
      .trim();
  }

  private url(value: string | undefined): string | undefined {
    const raw = value?.trim();
    if (!raw || /^(javascript|data|vbscript):/i.test(raw)) return undefined;
    try {
      return this.baseUrl ? new URL(raw, this.baseUrl).href : raw;
    } catch {
      return raw;
    }
  }

  private node(node: Node, parent: Element): string {
    if (typeof node === "string") return node.replace(/\s+/g, " ");
    const el = node;
    if (SKIPPED.has(el.tag) || isHidden(el)) return "";
    const block = (text: string) => (text.trim() === "" ? "" : `\n\n${text.trim()}\n\n`);

    switch (el.tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const text = this.inline(el);
        return text && block(`${"#".repeat(Number(el.tag[1]))} ${text}`);
      }
      case "br":
        return "\n";
      case "hr":
        return block("---");
      case "strong":
      case "b":
        return wrap(this.children(el), "**");
      case "em":
      case "i":
        return wrap(this.children(el), "_");
      case "del":
      case "s":
        return wrap(this.children(el), "~~");
      case "code":
      case "kbd":
      case "samp": {
        const text = textOf(el).replace(/\s+/g, " ");
        return wrap(text, text.includes("`") ? "``" : "`");
      }
      case "pre":
        return this.codeBlock(el);
      case "a": {
        const text = this.children(el);
        const href = el.attrs.href?.trim().startsWith("#") ? undefined : this.url(el.attrs.href);
        if (!href || text.trim() === "") return text;
        // A link around a whole block of content keeps the content, followed by the address.
        if (text.length > 300) return `${text.trimEnd()} (${href})\n\n`;
        const label = text.replace(/\s*\n\s*/g, " ").trim();
        return `${/^\s/.test(text) ? " " : ""}[${label}](${href})${/\s$/.test(text) ? " " : ""}`;
      }
      case "img": {
        const src = this.url(el.attrs.src);
        const alt = (el.attrs.alt ?? "").replace(/\s+/g, " ").trim();
        return src && alt ? `![${alt}](${src})` : "";
      }
      case "blockquote":
        return block(
          `> ${indent(
            this.children(el)
              .trim()
              .replace(/\n{3,}/g, "\n\n"),
            "> ",
          )}`,
        );
      case "ul":
      case "ol": {
        const list = this.list(el);
        return parent.tag === "li" ? `\n${list}\n` : block(list);
      }
      case "table":
        return block(this.table(el));
      default:
        return BLOCKS.has(el.tag) ? block(this.children(el)) : this.children(el);
    }
  }

  private list(el: Element): string {
    let number = Number.parseInt(el.attrs.start ?? "1", 10) || 1;
    const items: string[] = [];
    for (const child of el.children) {
      if (typeof child === "string" || SKIPPED.has(child.tag) || isHidden(child)) continue;
      // Anything that isn't an item is read as one, so that its content isn't lost.
      const text = this.children(child.tag === "li" ? child : { ...child, children: [child] })
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (text === "") continue;
      const marker = el.tag === "ol" ? `${number++}. ` : "- ";
      items.push(marker + indent(text, " ".repeat(marker.length)));
    }
    return items.join("\n");
  }

  private table(el: Element): string {
    const rows: Element[][] = [];
    const visit = (node: Element) => {
      for (const child of node.children) {
        if (typeof child === "string" || isHidden(child) || child.tag === "table") continue;
        if (child.tag !== "tr") visit(child);
        else {
          rows.push(
            child.children.filter(
              (c): c is Element => typeof c !== "string" && (c.tag === "td" || c.tag === "th"),
            ),
          );
        }
      }
    };
    visit(el);
    const width = Math.max(0, ...rows.map((r) => r.length));
    // A table that lays out the page (one column, one row, or blocks in its cells) keeps its
    // content and drops the grid.
    const layout = rows.flat().some((cell) => find(cell, LAYOUT_CONTENT));
    if (layout || width < 2 || rows.length < 2) {
      return rows
        .map((row) => join(row.map((cell) => ` ${this.children(cell).trim()} `)).trim())
        .filter(Boolean)
        .join("\n\n");
    }
    const lines = rows
      .map((row) => row.map((cell) => this.inline(cell).replaceAll("|", "\\|")))
      .filter((row) => row.some(Boolean))
      .map((row) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`);
    lines.splice(1, 0, `|${" --- |".repeat(width)}`);
    return lines.join("\n");
  }

  private codeBlock(el: Element): string {
    const text = textOf(el).replace(/^\n/, "").trimEnd();
    if (text.trim() === "") return "";
    const inner = el.children.find((c): c is Element => typeof c !== "string" && c.tag === "code");
    const classes = `${el.attrs.class ?? ""} ${inner?.attrs.class ?? ""}`;
    const language = /\b(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1] ?? "";
    const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    this.code.push(`${fence}${language}\n${text}\n${fence}`);
    return `\n\n\0${this.code.length - 1}\0\n\n`;
  }
}

/** Converts HTML to markdown. Relative links are resolved against `baseUrl` when given. */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  return new Renderer(baseUrl).render(parseHtml(html.replaceAll("\0", "")));
}
