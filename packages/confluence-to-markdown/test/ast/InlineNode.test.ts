import { describe, expect, it } from "@effect/vitest"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import {
  Emphasis,
  InlineCode,
  InlineNode,
  LineBreak,
  Link,
  Strong,
  Text,
  UnsupportedInline
} from "../../src/ast/InlineNode.js"

describe("InlineNode", () => {
  describe("Text", () => {
    it("creates text node", () => {
      const text = new Text({ value: "Hello world" })
      expect(text.value).toBe("Hello world")
      expect(text._tag).toBe("Text")
    })

    it("decodes from plain object", () => {
      const result = Schema.decodeUnknownEither(Text)({
        _tag: "Text",
        value: "test"
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.value).toBe("test")
      }
    })

    it("encodes to plain object", () => {
      const text = new Text({ value: "hello" })
      const result = Schema.encodeUnknownEither(Text)(text)
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right).toEqual({ _tag: "Text", value: "hello" })
      }
    })
  })

  describe("Strong", () => {
    it("creates strong node with children", () => {
      const strong = new Strong({
        children: [new Text({ value: "bold" })]
      })
      expect(strong._tag).toBe("Strong")
      expect(strong.children).toHaveLength(1)
    })

    it("decodes from plain object", () => {
      const result = Schema.decodeUnknownEither(Strong)({
        _tag: "Strong",
        children: [{ _tag: "Text", value: "bold" }]
      })
      expect(Either.isRight(result)).toBe(true)
    })
  })

  describe("Emphasis", () => {
    it("creates emphasis node with children", () => {
      const em = new Emphasis({
        children: [new Text({ value: "italic" })]
      })
      expect(em._tag).toBe("Emphasis")
      expect(em.children).toHaveLength(1)
    })
  })

  describe("InlineCode", () => {
    it("creates inline code node", () => {
      const code = new InlineCode({ value: "const x = 1" })
      expect(code._tag).toBe("InlineCode")
      expect(code.value).toBe("const x = 1")
    })
  })

  describe("Link", () => {
    it("creates link with href and children", () => {
      const link = new Link({
        href: "https://example.com",
        children: [new Text({ value: "Click" })]
      })
      expect(link._tag).toBe("Link")
      expect(link.href).toBe("https://example.com")
      expect(link.title).toBeUndefined()
    })

    it("creates link with optional title", () => {
      const link = new Link({
        href: "https://example.com",
        title: "Example",
        children: [new Text({ value: "Click" })]
      })
      expect(link.title).toBe("Example")
    })
  })

  describe("LineBreak", () => {
    it("creates line break node", () => {
      const br = new LineBreak({})
      expect(br._tag).toBe("LineBreak")
    })
  })

  describe("UnsupportedInline", () => {
    it("creates unsupported inline from confluence", () => {
      const unknown = new UnsupportedInline({
        raw: "<ac:custom/>",
        source: "confluence"
      })
      expect(unknown._tag).toBe("UnsupportedInline")
      expect(unknown.source).toBe("confluence")
    })

    it("creates unsupported inline from markdown", () => {
      const unknown = new UnsupportedInline({
        raw: "~~strike~~",
        source: "markdown"
      })
      expect(unknown.source).toBe("markdown")
    })
  })

  describe("InlineNode union", () => {
    it("decodes Text variant", () => {
      const result = Schema.decodeUnknownEither(InlineNode)({
        _tag: "Text",
        value: "hello"
      })
      expect(Either.isRight(result)).toBe(true)
    })

    it("decodes Strong variant", () => {
      const result = Schema.decodeUnknownEither(InlineNode)({
        _tag: "Strong",
        children: [{ _tag: "Text", value: "bold" }]
      })
      expect(Either.isRight(result)).toBe(true)
    })

    it("decodes Link variant", () => {
      const result = Schema.decodeUnknownEither(InlineNode)({
        _tag: "Link",
        href: "https://example.com",
        children: [{ _tag: "Text", value: "link" }]
      })
      expect(Either.isRight(result)).toBe(true)
    })

    it("rejects unknown tag", () => {
      const result = Schema.decodeUnknownEither(InlineNode)({
        _tag: "Unknown",
        value: "test"
      })
      expect(Either.isLeft(result)).toBe(true)
    })
  })
})
