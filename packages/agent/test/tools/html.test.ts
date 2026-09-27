import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToMarkdown } from "../../src/tools/html.js";

const md = (html: string, base?: string) => htmlToMarkdown(html, base);

describe("htmlToMarkdown", () => {
  it("converts headings, paragraphs and inline marks", () => {
    expect(md("<h1>Title</h1><p>Some <b>bold</b>, <em>soft</em> and <code>code</code>.</p>")).toBe(
      "# Title\n\nSome **bold**, _soft_ and `code`.",
    );
    expect(md("<h3> Spaced\n  out </h3>")).toBe("### Spaced out");
    expect(md("a<strong> b </strong>c")).toBe("a **b** c");
    expect(md("<p>a<br>b</p><hr><p>c</p>")).toBe("a\nb\n\n---\n\nc");
  });

  it("leaves out scripts, styles, the head, comments and hidden elements", () => {
    const html =
      "<!doctype html><html><head><title>T &amp; t</title><style>p{}</style></head><body>" +
      "<script>if (a < b) alert('<p>no</p>')</script><!-- <p>no</p> --><p>yes</p>" +
      '<noscript>no</noscript><p hidden>no</p><span aria-hidden="true">no</span><svg><text>no</text></svg>' +
      "</body></html>";
    expect(md(html)).toBe("T & t\n\nyes");
  });

  it("keeps the text of buttons", () => {
    expect(md("<button><span>Play video</span></button>")).toBe("Play video");
  });

  it("writes links, resolving them against the page's address", () => {
    expect(md('<a href="/x">link</a>')).toBe("[link](/x)");
    expect(md('<a href="/x?a=1&amp;b=2">link</a>', "https://a.test/dir/page")).toBe(
      "[link](https://a.test/x?a=1&b=2)",
    );
    expect(md('<a href="y">link</a>', "https://a.test/dir/page")).toBe(
      "[link](https://a.test/dir/y)",
    );
    expect(md("see <a href=/x> the docs </a>now")).toBe("see [the docs](/x) now");
    expect(md('<h2><a href="/x"><div>Head</div><div>line</div></a></h2>')).toBe(
      "## [Head line](/x)",
    );
  });

  it("keeps only the text of links that lead nowhere useful", () => {
    expect(md('<a href="javascript:void(0)">a</a> <a href="#top">b</a> <a>c</a>')).toBe("a b c");
    expect(md('<a href="/x"></a>')).toBe("");
  });

  it("writes images that have a description", () => {
    expect(md('<img src="/a.png" alt="A cat">', "https://a.test/")).toBe(
      "![A cat](https://a.test/a.png)",
    );
    expect(md('<img src="/a.png"><img alt="x" src="data:image/png;base64,AAAA">')).toBe("");
  });

  it("writes lists, nested and numbered", () => {
    expect(md("<ul><li>a<li>b<ul><li>c</li></ul></li></ul>")).toBe("- a\n- b\n  - c");
    expect(md('<ol start="3"><li>a</li><li><p>b</p><p>c</p></li></ol>')).toBe("3. a\n4. b\n\n   c");
  });

  it("writes quotes and code blocks, leaving code untouched", () => {
    expect(md("<blockquote><p>a</p><p>b</p></blockquote>")).toBe("> a\n>\n> b");
    expect(
      md('<pre><code class="language-js">if (a &lt; b) {\n\n\n  go();   \n}\n</code></pre>'),
    ).toBe("```js\nif (a < b) {\n\n\n  go();   \n}\n```");
    expect(md("<pre>a ``` b</pre>")).toBe("````\na ``` b\n````");
    expect(md("<code>a `b`</code>")).toBe("``a `b```");
  });

  it("writes tables, with or without closing tags", () => {
    const expected = "| Version | Changes |\n| --- | --- |\n| v14 | Changed `flags` \\| more |";
    expect(
      md(
        "<table><thead><tr><th>Version</th><th>Changes</th></tr></thead>" +
          "<tbody><tr><td>v14</td><td><p>Changed <code>flags</code> | more</p></td></tr></tbody></table>",
      ),
    ).toBe(expected);
    expect(
      md(
        "<table><thead><tr><th>Version<th>Changes<tbody><tr><td>v14<td><p>Changed <code>flags</code> | more</table>",
      ),
    ).toBe(expected);
    expect(md("<table><tr><td>only</td></tr><tr><td>layout</td></tr></table>")).toBe(
      "only\n\nlayout",
    );
  });

  it("ends a paragraph where the next block starts", () => {
    expect(md("<p>a<p>b<div>c</div>d")).toBe("a\n\nb\n\nc\n\nd");
  });

  it("reads malformed HTML without throwing", () => {
    expect(md("a < b and c > d")).toBe("a < b and c > d");
    expect(md("<p>open <b>bold</p><p>next")).toBe("open **bold**\n\nnext");
    expect(md("</div></p>text</span>")).toBe("text");
    expect(md("<p>cut <a href='x")).toBe("cut");
    expect(md("<div><<<>>></div>")).toBe("<<<>>>");
    expect(md("<!-- never closed <p>x</p>")).toBe("");
    expect(md("")).toBe("");
    expect(md("\0<p>a\0b</p>")).toBe("ab");
  });

  it("handles large and deeply nested input", () => {
    const deep = `${"<div>".repeat(5000)}x${"</div>".repeat(5000)}`;
    expect(md(deep)).toBe("x");
    const long = "<p>word </p>".repeat(50_000);
    expect(md(long).length).toBeGreaterThan(200_000);
  });

  it("reads a long run of stray < quickly", () => {
    const start = performance.now();
    expect(md("<".repeat(1_000_000)).length).toBe(1_000_000);
    expect(md(`${"< ".repeat(500_000)}<b>x</b>`)).toContain("**x**");
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("decodes entities", () => {
    expect(decodeEntities("&lt;a&gt; &amp; &quot;b&quot; &#65;&#x42; &mdash; &nope; &#0;")).toBe(
      '<a> & "b" AB — &nope; &#0;',
    );
  });
});
