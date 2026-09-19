import { Window } from "happy-dom"
import assert from "node:assert/strict"
import { test } from "vitest"
import { renderInline, renderMarkdown } from "../src/guide/markdown.js"

test("fence info accepts punctuated languages and metadata without consuming following prose", () => {
  for (
    const [info, language] of [["shell-session", "shell-session"], ["c++", "c--"], [
      "objective-c title=example",
      "objective-c"
    ]]
  ) {
    const { html } = renderMarkdown(`\`\`\`${info}\n<x>\n\`\`\`\n\nFollowing paragraph.`)
    assert.equal(html, `<pre><code class="lang-${language}">&lt;x&gt;</code></pre>\n<p>Following paragraph.</p>`)
  }
  const { html } = renderMarkdown("```ts\"onclick=\"bad metadata\ncode\n```")
  assert.equal(html, "<pre><code class=\"lang-ts-onclick--bad\">code</code></pre>")
})

test("inline: code wins over other markup, html is escaped, only safe links", () => {
  assert.equal(
    renderInline("a `<b>**x**</b>` **bold** *em* [t](https://x.y)"),
    "a <code>&lt;b&gt;**x**&lt;/b&gt;</code> <strong>bold</strong> <em>em</em> <a href=\"https://x.y\">t</a>"
  )
  assert.equal(renderInline("[bad](javascript:alert(1))"), "[bad](javascript:alert(1))")
  assert.equal(renderInline("snake_case_name stays"), "snake_case_name stays")
})

test("inline navigation keeps code and emphasis but cannot create nested links or executable HTML", () => {
  assert.equal(
    renderInline("Check `requestedRevision` and **[approval](#policy)** <img src=x onerror=alert(1)>", {
      links: false
    }),
    "Check <code>requestedRevision</code> and <strong>approval</strong> &lt;img src=x onerror=alert(1)&gt;"
  )
  assert.equal(
    renderInline("`[not a link](https://example.com)`", { links: false }),
    "<code>[not a link](https://example.com)</code>"
  )
})

test("link destinations stay literal while labels and surrounding text retain emphasis", () => {
  assert.equal(renderInline("[x](https://example.com/**foo**)"), "<a href=\"https://example.com/**foo**\">x</a>")
  assert.equal(
    renderInline("[*italic*](https://example.com/path)"),
    "<a href=\"https://example.com/path\"><em>italic</em></a>"
  )
  assert.equal(renderInline("[x](&#106;avascript:bad)"), "[x](&amp;#106;avascript:bad)")
  for (
    const href of [
      "https://example.com/**foo**",
      "https://example.com/*foo*",
      "https://example.com/_foo_",
      "/**foo**",
      "#**foo**"
    ]
  ) {
    assert.equal(renderInline(`[**bold**](${href})`), `<a href="${href}"><strong>bold</strong></a>`)
  }
  assert.equal(
    renderInline("**[plain](https://example.com/path)**"),
    "<strong><a href=\"https://example.com/path\">plain</a></strong>"
  )
  assert.equal(
    renderInline("[<label>](https://example.com/?q=**a**&x=\"quoted\")"),
    "<a href=\"https://example.com/?q=**a**&amp;x=&quot;quoted&quot;\">&lt;label&gt;</a>"
  )
  assert.equal(renderInline("[**bold**](https://example.com/**foo**)", { links: false }), "<strong>bold</strong>")
  assert.equal(renderInline("`[x](https://example.com/**foo**)`"), "<code>[x](https://example.com/**foo**)</code>")
})

test("unsafe destinations stay non-navigable with formatted labels", () => {
  const window = new Window()
  try {
    for (const href of ["javascript:bad", "data:text/html,bad", "&#106;avascript:bad"]) {
      window.document.body.innerHTML = renderInline(`[**safe label**](${href})`)
      assert.equal(window.document.querySelectorAll("a").length, 0)
      assert.equal(window.document.querySelector("strong")?.textContent, "safe label")
      assert.equal(window.document.body.textContent, `[safe label](${href})`)
    }
  } finally {
    window.close()
  }
})

test("blocks: paragraphs, headings, bullets, callouts, fences", () => {
  const { html, mermaid } = renderMarkdown(`Intro line
continues.

### Why

- one
- two
  wrapped

> [!WARNING]
> Careful with \`x\`.

> plain quote

\`\`\`ts
const a = "<x>";
\`\`\``)
  assert.equal(mermaid, false)
  assert.equal(
    html,
    [
      "<p>Intro line continues.</p>",
      "<h4>Why</h4>",
      "<ul><li>one</li><li>two wrapped</li></ul>",
      "<aside class=\"callout callout-warning\"><span class=\"callout-label\">WARNING</span><p>Careful with <code>x</code>.</p></aside>",
      "<blockquote><p>plain quote</p></blockquote>",
      "<pre><code class=\"lang-ts\">const a = &quot;&lt;x&gt;&quot;;</code></pre>"
    ].join("\n")
  )
})

test("a mermaid fence becomes a diagram and flags the page", () => {
  const { html, mermaid } = renderMarkdown("```mermaid\nsequenceDiagram\n  A->>B: hi\n```")
  assert.equal(mermaid, true)
  assert.equal(html, "<pre class=\"mermaid\">sequenceDiagram\n  A-&gt;&gt;B: hi</pre>")
})

test("balanced and escaped destination parentheses preserve exact URLs", () => {
  const cases = [
    ["https://en.wikipedia.org/wiki/Function_(mathematics)", "https://en.wikipedia.org/wiki/Function_(mathematics)"],
    [String.raw`https://example.com/one\(two\)`, "https://example.com/one(two)"],
    [String.raw`https://example.com/one\)two`, "https://example.com/one)two"],
    ["https://example.com/a(b(c(d)))", "https://example.com/a(b(c(d)))"],
    [String.raw`https://example.com/a\\(b)`, String.raw`https://example.com/a\(b)`],
    ["https://example.com/**star**(suffix)", "https://example.com/**star**(suffix)"],
    ["https://example.com/?q=(a)&v=\"b\"", "https://example.com/?q=(a)&amp;v=&quot;b&quot;"],
    ["https://example.com/plain", "https://example.com/plain"]
  ]
  for (const [source, href] of cases) {
    assert.equal(renderInline(`[**label**](${source}) tail`), `<a href="${href}"><strong>label</strong></a> tail`)
    assert.equal(renderInline(`[**label**](${source})`, { links: false }), "<strong>label</strong>")
  }
  assert.equal(
    renderInline("**[label](https://example.com/a(b))**"),
    "<strong><a href=\"https://example.com/a(b)\">label</a></strong>"
  )
  assert.equal(
    renderInline("[one](https://example.com/a(b))[two](https://example.com/c(d))"),
    "<a href=\"https://example.com/a(b)\">one</a><a href=\"https://example.com/c(d)\">two</a>"
  )
  for (
    const source of [
      "[label](https://example.com/a(b)",
      "[label](https://example.com/a b)",
      "[label](javascript:alert(1))",
      String.raw`[label](javascript:alert\(1\))`
    ]
  ) {
    assert.equal(renderInline(source).includes("<a "), false, source)
  }
})
