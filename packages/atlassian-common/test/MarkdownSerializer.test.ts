import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { Emphasis, Heading, makeDocument, Paragraph, Strong, Text } from "../src/ast/index.js"
import { serializeToMarkdown } from "../src/serializers/MarkdownSerializer.js"

describe("MarkdownSerializer", () => {
  describe("serializeToMarkdown", () => {
    // Headings map to ATX-style markdown (# Title) — core block-level rendering
    it.effect("serializes heading", () =>
      Effect.gen(function*() {
        const doc = makeDocument([
          new Heading({ level: 1, children: [new Text({ value: "Title" })] })
        ])
        const result = yield* serializeToMarkdown(doc)
        expect(result).toBe("# Title")
      }))

    // Paragraphs render as plain text — the simplest block element
    it.effect("serializes paragraph", () =>
      Effect.gen(function*() {
        const doc = makeDocument([
          new Paragraph({ children: [new Text({ value: "Hello world" })] })
        ])
        const result = yield* serializeToMarkdown(doc)
        expect(result).toBe("Hello world")
      }))

    // Strong text wraps in ** — verifies inline formatting within paragraph flow
    it.effect("serializes strong text", () =>
      Effect.gen(function*() {
        const doc = makeDocument([
          new Paragraph({
            children: [
              new Text({ value: "This is " }),
              new Strong({ children: [new Text({ value: "bold" })] }),
              new Text({ value: " text" })
            ]
          })
        ])
        const result = yield* serializeToMarkdown(doc)
        expect(result).toBe("This is **bold** text")
      }))

    // Emphasis wraps in * — distinct from strong (**) to verify correct delimiter
    it.effect("serializes emphasis text", () =>
      Effect.gen(function*() {
        const doc = makeDocument([
          new Paragraph({
            children: [
              new Emphasis({ children: [new Text({ value: "italic" })] })
            ]
          })
        ])
        const result = yield* serializeToMarkdown(doc)
        expect(result).toBe("*italic*")
      }))

    // Multiple blocks separated by blank lines — standard markdown block spacing
    it.effect("serializes multiple blocks with blank line separator", () =>
      Effect.gen(function*() {
        const doc = makeDocument([
          new Heading({ level: 1, children: [new Text({ value: "Title" })] }),
          new Paragraph({ children: [new Text({ value: "Content" })] })
        ])
        const result = yield* serializeToMarkdown(doc)
        expect(result).toBe("# Title\n\nContent")
      }))

    // Raw source embedding allows round-trip debugging — HTML comment with base64-encoded original
    it.effect("includes raw source when option enabled", () =>
      Effect.gen(function*() {
        const doc = makeDocument(
          [new Paragraph({ children: [new Text({ value: "Test" })] })],
          "<p>Test</p>"
        )
        const result = yield* serializeToMarkdown(doc, { includeRawSource: true })
        expect(result).toContain("<!--src:raw:")
        expect(result).toContain("Test")
      }))
  })
})
