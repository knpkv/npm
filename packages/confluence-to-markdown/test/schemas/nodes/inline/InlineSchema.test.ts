import { describe, expect, it } from "@effect/vitest"
import type { UnsupportedInline } from "../../../../src/ast/InlineNode.js"
import { Emphasis, InlineCode, LineBreak, Link, Strong, Text } from "../../../../src/ast/InlineNode.js"
import { makeHastText } from "../../../../src/schemas/hast/index.js"
import { makeMdastText } from "../../../../src/schemas/mdast/index.js"
import {
  inlineNodeFromMdast,
  inlineNodeToHast,
  inlineNodeToMdast,
  textFromHastText
} from "../../../../src/schemas/nodes/inline/index.js"

describe("InlineSchema", () => {
  describe("textFromHastText", () => {
    it("converts hast text to Text node", () => {
      const hastText = makeHastText("hello")
      const result = textFromHastText(hastText)
      expect(result._tag).toBe("Text")
      expect(result.value).toBe("hello")
    })
  })

  describe("inlineNodeToHast", () => {
    it("converts Text to hast text", () => {
      const text = new Text({ value: "hello" })
      const result = inlineNodeToHast(text)
      expect(result._tag).toBe("text")
      expect((result as { value: string }).value).toBe("hello")
    })

    it("converts Strong to hast strong", () => {
      const strong = new Strong({ children: [new Text({ value: "bold" })] })
      const result = inlineNodeToHast(strong)
      expect(result._tag).toBe("element")
      expect((result as { tagName: string }).tagName).toBe("strong")
    })

    it("converts Emphasis to hast em", () => {
      const emphasis = new Emphasis({ children: [new Text({ value: "italic" })] })
      const result = inlineNodeToHast(emphasis)
      expect(result._tag).toBe("element")
      expect((result as { tagName: string }).tagName).toBe("em")
    })

    it("converts InlineCode to hast code", () => {
      const code = new InlineCode({ value: "const x = 1" })
      const result = inlineNodeToHast(code)
      expect(result._tag).toBe("element")
      expect((result as { tagName: string }).tagName).toBe("code")
    })

    it("converts Link to hast anchor", () => {
      const link = new Link({
        href: "https://example.com",
        title: "Example",
        children: [new Text({ value: "click" })]
      })
      const result = inlineNodeToHast(link)
      expect(result._tag).toBe("element")
      expect((result as { tagName: string }).tagName).toBe("a")
    })

    it("converts LineBreak to hast br", () => {
      const br = new LineBreak({})
      const result = inlineNodeToHast(br)
      expect(result._tag).toBe("element")
      expect((result as { tagName: string }).tagName).toBe("br")
    })
  })

  describe("inlineNodeToMdast", () => {
    it("converts Text to mdast text", () => {
      const text = new Text({ value: "hello" })
      const result = inlineNodeToMdast(text)
      expect(result.type).toBe("text")
      expect((result as { value: string }).value).toBe("hello")
    })

    it("converts Strong to mdast strong", () => {
      const strong = new Strong({ children: [new Text({ value: "bold" })] })
      const result = inlineNodeToMdast(strong)
      expect(result.type).toBe("strong")
    })

    it("converts Emphasis to mdast emphasis", () => {
      const emphasis = new Emphasis({ children: [new Text({ value: "italic" })] })
      const result = inlineNodeToMdast(emphasis)
      expect(result.type).toBe("emphasis")
    })

    it("converts InlineCode to mdast inlineCode", () => {
      const code = new InlineCode({ value: "x" })
      const result = inlineNodeToMdast(code)
      expect(result.type).toBe("inlineCode")
      expect((result as { value: string }).value).toBe("x")
    })

    it("converts Link to mdast link", () => {
      const link = new Link({
        href: "https://example.com",
        children: [new Text({ value: "click" })]
      })
      const result = inlineNodeToMdast(link)
      expect(result.type).toBe("link")
      expect((result as { url: string }).url).toBe("https://example.com")
    })

    it("converts LineBreak to mdast break", () => {
      const br = new LineBreak({})
      const result = inlineNodeToMdast(br)
      expect(result.type).toBe("break")
    })
  })

  describe("inlineNodeFromMdast", () => {
    it("converts mdast text to Text", () => {
      const mdast = makeMdastText("hello")
      const result = inlineNodeFromMdast(mdast)
      expect(result._tag).toBe("Text")
      expect((result as Text).value).toBe("hello")
    })

    it("converts mdast strong to Strong", () => {
      const mdast = { type: "strong" as const, children: [makeMdastText("bold")] }
      const result = inlineNodeFromMdast(mdast)
      expect(result._tag).toBe("Strong")
    })

    it("converts mdast emphasis to Emphasis", () => {
      const mdast = { type: "emphasis" as const, children: [makeMdastText("italic")] }
      const result = inlineNodeFromMdast(mdast)
      expect(result._tag).toBe("Emphasis")
    })

    it("converts mdast inlineCode to InlineCode", () => {
      const mdast = { type: "inlineCode" as const, value: "x" }
      const result = inlineNodeFromMdast(mdast)
      expect(result._tag).toBe("InlineCode")
      expect((result as InlineCode).value).toBe("x")
    })

    it("converts mdast link to Link", () => {
      const mdast = {
        type: "link" as const,
        url: "https://example.com",
        title: null,
        children: [makeMdastText("click")]
      }
      const result = inlineNodeFromMdast(mdast)
      expect(result._tag).toBe("Link")
      expect((result as Link).href).toBe("https://example.com")
    })

    it("converts mdast break to LineBreak", () => {
      const mdast = { type: "break" as const }
      const result = inlineNodeFromMdast(mdast)
      expect(result._tag).toBe("LineBreak")
    })

    it("converts mdast delete to Strikethrough", () => {
      const mdast = { type: "delete" as const, children: [makeMdastText("deleted")] }
      const result = inlineNodeFromMdast(mdast)
      expect(result._tag).toBe("Strikethrough")
    })

    it("converts mdast html to UnsupportedInline", () => {
      const mdast = { type: "html" as const, value: "<custom>x</custom>" }
      const result = inlineNodeFromMdast(mdast)
      expect(result._tag).toBe("UnsupportedInline")
      expect((result as UnsupportedInline).raw).toBe("<custom>x</custom>")
    })
  })

  describe("roundtrip", () => {
    it("Text roundtrips through MDAST", () => {
      const original = new Text({ value: "hello" })
      const mdast = inlineNodeToMdast(original)
      const result = inlineNodeFromMdast(mdast)
      expect(result._tag).toBe("Text")
      expect((result as Text).value).toBe("hello")
    })

    it("Strong roundtrips through MDAST", () => {
      const original = new Strong({ children: [new Text({ value: "bold" })] })
      const mdast = inlineNodeToMdast(original)
      const result = inlineNodeFromMdast(mdast)
      expect(result._tag).toBe("Strong")
    })

    it("Text roundtrips through HAST", () => {
      const original = new Text({ value: "hello" })
      const hast = inlineNodeToHast(original)
      const result = textFromHastText(hast as { _tag: "text"; value: string })
      expect(result._tag).toBe("Text")
      expect(result.value).toBe("hello")
    })
  })
})
