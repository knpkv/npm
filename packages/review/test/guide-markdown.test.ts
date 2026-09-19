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
