import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { ConfluenceToMarkdown, DocumentFromHast, DocumentFromMdast } from "../../src/schemas/ConversionSchema.js"
import { HastFromHtml } from "../../src/schemas/hast/index.js"
import { MdastFromMarkdown } from "../../src/schemas/mdast/index.js"

describe("ConversionSchema", () => {
  describe("DocumentFromHast", () => {
    it.effect("converts simple HAST root to Document", () =>
      Effect.gen(function*() {
        const html = "<h1>Title</h1><p>Hello world</p>"
        const hast = yield* Schema.decode(HastFromHtml)(html)
        const doc = yield* Schema.decode(DocumentFromHast)(hast)

        expect(doc.version).toBe(1)
        expect(doc.children.length).toBe(2)
        expect(doc.children[0]?._tag).toBe("Heading")
        expect(doc.children[1]?._tag).toBe("Paragraph")
      }))

    it.effect("handles code blocks", () =>
      Effect.gen(function*() {
        const html = "<pre><code>const x = 1</code></pre>"
        const hast = yield* Schema.decode(HastFromHtml)(html)
        const doc = yield* Schema.decode(DocumentFromHast)(hast)

        expect(doc.children[0]?._tag).toBe("CodeBlock")
      }))

    it.effect("handles empty input", () =>
      Effect.gen(function*() {
        const html = ""
        const hast = yield* Schema.decode(HastFromHtml)(html)
        const doc = yield* Schema.decode(DocumentFromHast)(hast)

        expect(doc.children.length).toBe(0)
      }))
  })

  describe("DocumentFromMdast", () => {
    it.effect("converts simple MDAST root to Document", () =>
      Effect.gen(function*() {
        const md = "# Title\n\nHello world"
        const mdast = yield* Schema.decode(MdastFromMarkdown)(md)
        const doc = yield* Schema.decode(DocumentFromMdast)(mdast)

        expect(doc.version).toBe(1)
        expect(doc.children.length).toBe(2)
        expect(doc.children[0]?._tag).toBe("Heading")
        expect(doc.children[1]?._tag).toBe("Paragraph")
      }))

    it.effect("handles code blocks", () =>
      Effect.gen(function*() {
        const md = "```ts\nconst x = 1\n```"
        const mdast = yield* Schema.decode(MdastFromMarkdown)(md)
        const doc = yield* Schema.decode(DocumentFromMdast)(mdast)

        expect(doc.children[0]?._tag).toBe("CodeBlock")
      }))

    it.effect("handles lists", () =>
      Effect.gen(function*() {
        const md = "- Item 1\n- Item 2"
        const mdast = yield* Schema.decode(MdastFromMarkdown)(md)
        const doc = yield* Schema.decode(DocumentFromMdast)(mdast)

        expect(doc.children[0]?._tag).toBe("List")
      }))
  })

  describe("ConfluenceToMarkdown", () => {
    it.effect("decodes simple Confluence HTML to Markdown", () =>
      Effect.gen(function*() {
        const html = "<h1>Title</h1><p>Hello world</p>"
        const md = yield* Schema.decode(ConfluenceToMarkdown)(html)

        expect(md).toContain("# Title")
        expect(md).toContain("Hello world")
      }))

    it.effect("decodes code blocks", () =>
      Effect.gen(function*() {
        const html = "<pre><code class=\"language-ts\">const x = 1</code></pre>"
        const md = yield* Schema.decode(ConfluenceToMarkdown)(html)

        expect(md).toContain("```")
        expect(md).toContain("const x = 1")
      }))

    it.effect("decodes inline formatting", () =>
      Effect.gen(function*() {
        const html = "<p><strong>bold</strong> and <em>italic</em></p>"
        const md = yield* Schema.decode(ConfluenceToMarkdown)(html)

        expect(md).toContain("**bold**")
        expect(md).toContain("_italic_")
      }))

    it.effect("encodes Markdown to basic HTML (structure only)", () =>
      Effect.gen(function*() {
        const md = "# Title\n\nHello world"
        const html = yield* Schema.encode(ConfluenceToMarkdown)(md)

        // Note: basic HTML encoding only preserves structure, not content
        expect(html).toContain("<h1>")
        expect(html).toContain("<p>")
      }))

    it.effect("handles links", () =>
      Effect.gen(function*() {
        const html = "<p><a href=\"https://example.com\">Click here</a></p>"
        const md = yield* Schema.decode(ConfluenceToMarkdown)(html)

        expect(md).toContain("[Click here](https://example.com)")
      }))

    it.effect("handles horizontal rules", () =>
      Effect.gen(function*() {
        const html = "<hr />"
        const md = yield* Schema.decode(ConfluenceToMarkdown)(html)

        expect(md).toContain("---")
      }))

    it.effect("handles lists", () =>
      Effect.gen(function*() {
        const html = "<ul><li><p>Item 1</p></li><li><p>Item 2</p></li></ul>"
        const md = yield* Schema.decode(ConfluenceToMarkdown)(html)

        expect(md).toContain("- ")
        expect(md).toContain("Item 1")
        expect(md).toContain("Item 2")
      }))

    it.effect("handles tables", () =>
      Effect.gen(function*() {
        const html = "<table><tr><th>A</th></tr><tr><td>1</td></tr></table>"
        const md = yield* Schema.decode(ConfluenceToMarkdown)(html)

        expect(md).toContain("|")
        expect(md).toContain("---")
      }))
  })

  describe("roundtrip", () => {
    it.effect("HTML -> Markdown -> HTML preserves structure", () =>
      Effect.gen(function*() {
        // Start from HTML since that direction is fully supported
        const originalHtml = "<h1>Hello</h1><p>World</p>"
        const md = yield* Schema.decode(ConfluenceToMarkdown)(originalHtml)
        const html = yield* Schema.encode(ConfluenceToMarkdown)(md)

        // Structure is preserved
        expect(html).toContain("<h1>")
        expect(html).toContain("<p>")
      }))
  })
})
