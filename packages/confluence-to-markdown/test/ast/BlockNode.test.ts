import { describe, expect, it } from "@effect/vitest"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import {
  BlockNode,
  BlockQuote,
  CodeBlock,
  Heading,
  Image,
  List,
  ListItem,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  ThematicBreak,
  UnsupportedBlock
} from "../../src/ast/BlockNode.js"
import { Text } from "../../src/ast/InlineNode.js"

describe("BlockNode", () => {
  describe("Heading", () => {
    it("creates heading with level and children", () => {
      const h1 = new Heading({
        level: 1,
        children: [new Text({ value: "Title" })]
      })
      expect(h1._tag).toBe("Heading")
      expect(h1.level).toBe(1)
      expect(h1.version).toBe(1)
    })

    it("decodes heading from plain object", () => {
      const result = Schema.decodeUnknownEither(Heading)({
        _tag: "Heading",
        level: 2,
        children: [{ _tag: "Text", value: "Subtitle" }]
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.level).toBe(2)
        expect(result.right.version).toBe(1)
      }
    })

    it("rejects invalid level", () => {
      const result = Schema.decodeUnknownEither(Heading)({
        _tag: "Heading",
        level: 7,
        children: []
      })
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("Paragraph", () => {
    it("creates paragraph with children", () => {
      const para = new Paragraph({
        children: [new Text({ value: "Hello" })]
      })
      expect(para._tag).toBe("Paragraph")
      expect(para.children).toHaveLength(1)
    })
  })

  describe("CodeBlock", () => {
    it("creates code block with language", () => {
      const code = new CodeBlock({
        language: "typescript",
        code: "const x = 1"
      })
      expect(code._tag).toBe("CodeBlock")
      expect(code.language).toBe("typescript")
      expect(code.code).toBe("const x = 1")
    })

    it("creates code block without language", () => {
      const code = new CodeBlock({ code: "plain text" })
      expect(code.language).toBeUndefined()
    })
  })

  describe("ThematicBreak", () => {
    it("creates thematic break", () => {
      const hr = new ThematicBreak({})
      expect(hr._tag).toBe("ThematicBreak")
    })
  })

  describe("Image", () => {
    it("creates image with src", () => {
      const img = new Image({
        src: "https://example.com/img.png"
      })
      expect(img._tag).toBe("Image")
      expect(img.src).toBe("https://example.com/img.png")
    })

    it("creates image with alt and title", () => {
      const img = new Image({
        src: "https://example.com/img.png",
        alt: "Alt text",
        title: "Image title"
      })
      expect(img.alt).toBe("Alt text")
      expect(img.title).toBe("Image title")
    })
  })

  describe("Table", () => {
    it("creates table with header and rows", () => {
      const table = new Table({
        header: new TableRow({
          cells: [
            new TableCell({
              isHeader: true,
              children: [new Text({ value: "Col 1" })]
            })
          ]
        }),
        rows: [
          new TableRow({
            cells: [
              new TableCell({
                children: [new Text({ value: "Data" })]
              })
            ]
          })
        ]
      })
      expect(table._tag).toBe("Table")
      expect(table.header?.cells).toHaveLength(1)
      expect(table.rows).toHaveLength(1)
    })
  })

  describe("List", () => {
    it("creates unordered list", () => {
      const result = Schema.decodeUnknownEither(List)({
        _tag: "List",
        ordered: false,
        children: [
          {
            _tag: "ListItem",
            children: [
              {
                _tag: "Paragraph",
                children: [{ _tag: "Text", value: "Item 1" }]
              }
            ]
          }
        ]
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.ordered).toBe(false)
        expect(result.right.children).toHaveLength(1)
      }
    })

    it("creates ordered list with start", () => {
      const result = Schema.decodeUnknownEither(List)({
        _tag: "List",
        ordered: true,
        start: 5,
        children: []
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.start).toBe(5)
      }
    })
  })

  describe("ListItem", () => {
    it("creates list item with checked state", () => {
      const result = Schema.decodeUnknownEither(ListItem)({
        _tag: "ListItem",
        checked: true,
        children: [
          {
            _tag: "Paragraph",
            children: [{ _tag: "Text", value: "Done" }]
          }
        ]
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.checked).toBe(true)
      }
    })
  })

  describe("BlockQuote", () => {
    it("creates block quote with children", () => {
      const result = Schema.decodeUnknownEither(BlockQuote)({
        _tag: "BlockQuote",
        children: [
          {
            _tag: "Paragraph",
            children: [{ _tag: "Text", value: "Quote" }]
          }
        ]
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.children).toHaveLength(1)
      }
    })
  })

  describe("UnsupportedBlock", () => {
    it("creates unsupported block from confluence", () => {
      const block = new UnsupportedBlock({
        rawHtml: "<ac:macro/>",
        source: "confluence"
      })
      expect(block._tag).toBe("UnsupportedBlock")
      expect(block.source).toBe("confluence")
    })
  })

  describe("BlockNode union", () => {
    it("decodes Heading variant", () => {
      const result = Schema.decodeUnknownEither(BlockNode)({
        _tag: "Heading",
        level: 1,
        children: []
      })
      expect(Either.isRight(result)).toBe(true)
    })

    it("decodes Paragraph variant", () => {
      const result = Schema.decodeUnknownEither(BlockNode)({
        _tag: "Paragraph",
        children: [{ _tag: "Text", value: "text" }]
      })
      expect(Either.isRight(result)).toBe(true)
    })

    it("decodes List variant", () => {
      const result = Schema.decodeUnknownEither(BlockNode)({
        _tag: "List",
        ordered: true,
        children: []
      })
      expect(Either.isRight(result)).toBe(true)
    })

    it("decodes BlockQuote variant", () => {
      const result = Schema.decodeUnknownEither(BlockNode)({
        _tag: "BlockQuote",
        children: []
      })
      expect(Either.isRight(result)).toBe(true)
    })

    it("rejects unknown tag", () => {
      const result = Schema.decodeUnknownEither(BlockNode)({
        _tag: "Unknown"
      })
      expect(Either.isLeft(result)).toBe(true)
    })
  })
})
