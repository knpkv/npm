import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { layer as MarkdownConverterLayer, MarkdownConverter } from "../src/MarkdownConverter.js"

describe("MarkdownConverter", () => {
  describe("htmlToMarkdown", () => {
    it.effect("converts basic HTML to markdown", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const html = "<p>Hello <strong>world</strong></p>"
        const markdown = yield* converter.htmlToMarkdown(html)
        expect(markdown).toContain("Hello")
        expect(markdown).toContain("**world**")
      }).pipe(Effect.provide(MarkdownConverterLayer)))

    it.effect("converts headings", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const html = "<h1>Title</h1><h2>Subtitle</h2>"
        const markdown = yield* converter.htmlToMarkdown(html)
        expect(markdown).toContain("# Title")
        expect(markdown).toContain("## Subtitle")
      }).pipe(Effect.provide(MarkdownConverterLayer)))

    it.effect("converts lists", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const html = "<ul><li>Item 1</li><li>Item 2</li></ul>"
        const markdown = yield* converter.htmlToMarkdown(html)
        expect(markdown).toContain("* Item 1")
        expect(markdown).toContain("* Item 2")
      }).pipe(Effect.provide(MarkdownConverterLayer)))

    it.effect("converts links", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const html = "<a href=\"https://example.com\">Link</a>"
        const markdown = yield* converter.htmlToMarkdown(html)
        expect(markdown).toContain("[Link](https://example.com)")
      }).pipe(Effect.provide(MarkdownConverterLayer)))

    it.effect("converts code blocks", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const html = "<pre><code>const x = 1;</code></pre>"
        const markdown = yield* converter.htmlToMarkdown(html)
        expect(markdown).toContain("```")
        expect(markdown).toContain("const x = 1;")
      }).pipe(Effect.provide(MarkdownConverterLayer)))

    it.effect("strips Confluence macros with rich-text-body", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const html =
          "<ac:structured-macro ac:name=\"info\"><ac:rich-text-body><p>Content</p></ac:rich-text-body></ac:structured-macro>"
        const markdown = yield* converter.htmlToMarkdown(html)
        expect(markdown).toContain("Content")
        expect(markdown).not.toContain("ac:structured-macro")
      }).pipe(Effect.provide(MarkdownConverterLayer)))

    it.effect("converts Confluence code macros to code blocks", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const html =
          "<ac:structured-macro ac:name=\"code\"><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>"
        const markdown = yield* converter.htmlToMarkdown(html)
        expect(markdown).toContain("const x = 1;")
        expect(markdown).toContain("```")
      }).pipe(Effect.provide(MarkdownConverterLayer)))
  })

  describe("markdownToHtml", () => {
    it.effect("converts basic markdown to HTML", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const markdown = "Hello **world**"
        const html = yield* converter.markdownToHtml(markdown)
        expect(html).toContain("<strong>world</strong>")
      }).pipe(Effect.provide(MarkdownConverterLayer)))

    it.effect("converts headings", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const markdown = "# Title\n\n## Subtitle"
        const html = yield* converter.markdownToHtml(markdown)
        expect(html).toContain("<h1>Title</h1>")
        expect(html).toContain("<h2>Subtitle</h2>")
      }).pipe(Effect.provide(MarkdownConverterLayer)))

    it.effect("converts GFM tables", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const markdown = "| A | B |\n|---|---|\n| 1 | 2 |"
        const html = yield* converter.markdownToHtml(markdown)
        expect(html).toContain("<table>")
        expect(html).toContain("<th>A</th>")
        expect(html).toContain("<td>1</td>")
      }).pipe(Effect.provide(MarkdownConverterLayer)))

    it.effect("converts task lists", () =>
      Effect.gen(function*() {
        const converter = yield* MarkdownConverter
        const markdown = "- [ ] Todo\n- [x] Done"
        const html = yield* converter.markdownToHtml(markdown)
        expect(html).toContain("checkbox")
      }).pipe(Effect.provide(MarkdownConverterLayer)))
  })
})
