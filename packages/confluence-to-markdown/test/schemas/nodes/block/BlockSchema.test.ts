import { describe, expect, it } from "@effect/vitest"
import type { UnsupportedBlock } from "../../../../src/ast/BlockNode.js"
import {
  CodeBlock,
  Heading,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  ThematicBreak
} from "../../../../src/ast/BlockNode.js"
import { Text } from "../../../../src/ast/InlineNode.js"
import { makeMdastHeading, makeMdastParagraph, makeMdastText } from "../../../../src/schemas/mdast/index.js"
import { blockNodeFromMdast, blockNodeToHast, blockNodeToMdast } from "../../../../src/schemas/nodes/block/index.js"

describe("BlockSchema", () => {
  describe("blockNodeToHast", () => {
    it("converts Heading to hast h element", () => {
      const heading = new Heading({ level: 2, children: [new Text({ value: "Title" })] })
      const result = blockNodeToHast(heading)
      expect(result._tag).toBe("element")
      expect(result.tagName).toBe("h2")
    })

    it("converts Paragraph to hast p element", () => {
      const para = new Paragraph({ children: [new Text({ value: "Hello" })] })
      const result = blockNodeToHast(para)
      expect(result._tag).toBe("element")
      expect(result.tagName).toBe("p")
    })

    it("converts CodeBlock to hast pre/code elements", () => {
      const code = new CodeBlock({ code: "const x = 1", language: "ts" })
      const result = blockNodeToHast(code)
      expect(result._tag).toBe("element")
      expect(result.tagName).toBe("pre")
      expect(result.properties?.dataLanguage).toBe("ts")
    })

    it("converts ThematicBreak to hast hr element", () => {
      const hr = new ThematicBreak({})
      const result = blockNodeToHast(hr)
      expect(result._tag).toBe("element")
      expect(result.tagName).toBe("hr")
    })

    it("converts Table to hast table element", () => {
      const table = new Table({
        header: new TableRow({
          cells: [new TableCell({ isHeader: true, children: [new Text({ value: "Col" })] })]
        }),
        rows: [
          new TableRow({
            cells: [new TableCell({ children: [new Text({ value: "Val" })] })]
          })
        ]
      })
      const result = blockNodeToHast(table)
      expect(result._tag).toBe("element")
      expect(result.tagName).toBe("table")
    })
  })

  describe("blockNodeToMdast", () => {
    it("converts Heading to mdast heading", () => {
      const heading = new Heading({ level: 1, children: [new Text({ value: "Title" })] })
      const result = blockNodeToMdast(heading)
      expect(result.type).toBe("heading")
    })

    it("converts Paragraph to mdast paragraph", () => {
      const para = new Paragraph({ children: [new Text({ value: "Hello" })] })
      const result = blockNodeToMdast(para)
      expect(result.type).toBe("paragraph")
    })

    it("converts CodeBlock to mdast code", () => {
      const code = new CodeBlock({ code: "const x = 1", language: "ts" })
      const result = blockNodeToMdast(code)
      expect(result.type).toBe("code")
      expect((result as { value: string }).value).toBe("const x = 1")
    })

    it("converts ThematicBreak to mdast thematicBreak", () => {
      const hr = new ThematicBreak({})
      const result = blockNodeToMdast(hr)
      expect(result.type).toBe("thematicBreak")
    })

    it("converts Table to mdast table", () => {
      const table = new Table({ rows: [] })
      const result = blockNodeToMdast(table)
      expect(result.type).toBe("table")
    })
  })

  describe("blockNodeFromMdast", () => {
    it("converts mdast heading to Heading", () => {
      const mdast = makeMdastHeading(2, [makeMdastText("Title")])
      const result = blockNodeFromMdast(mdast)
      expect(result._tag).toBe("Heading")
      expect((result as Heading).level).toBe(2)
    })

    it("converts mdast paragraph to Paragraph", () => {
      const mdast = makeMdastParagraph([makeMdastText("Hello")])
      const result = blockNodeFromMdast(mdast)
      expect(result._tag).toBe("Paragraph")
    })

    it("converts mdast code to CodeBlock", () => {
      const mdast = { type: "code" as const, value: "const x = 1", lang: "ts" }
      const result = blockNodeFromMdast(mdast)
      expect(result._tag).toBe("CodeBlock")
      expect((result as CodeBlock).code).toBe("const x = 1")
      expect((result as CodeBlock).language).toBe("ts")
    })

    it("converts mdast thematicBreak to ThematicBreak", () => {
      const mdast = { type: "thematicBreak" as const }
      const result = blockNodeFromMdast(mdast)
      expect(result._tag).toBe("ThematicBreak")
    })

    it("converts mdast blockquote to BlockQuote", () => {
      const mdast = {
        type: "blockquote" as const,
        children: [makeMdastParagraph([makeMdastText("Quote")])]
      }
      const result = blockNodeFromMdast(mdast)
      expect(result._tag).toBe("BlockQuote")
    })

    it("converts mdast list to List", () => {
      const mdast = {
        type: "list" as const,
        ordered: true,
        children: [{
          type: "listItem" as const,
          children: [makeMdastParagraph([makeMdastText("Item")])]
        }]
      }
      const result = blockNodeFromMdast(mdast)
      expect(result._tag).toBe("List")
    })

    it("converts mdast html to UnsupportedBlock", () => {
      const mdast = { type: "html" as const, value: "<custom>x</custom>" }
      const result = blockNodeFromMdast(mdast)
      expect(result._tag).toBe("UnsupportedBlock")
      expect((result as UnsupportedBlock).rawMarkdown).toBe("<custom>x</custom>")
    })
  })

  describe("roundtrip", () => {
    it("Heading roundtrips through MDAST", () => {
      const original = new Heading({ level: 3, children: [new Text({ value: "Title" })] })
      const mdast = blockNodeToMdast(original)
      const result = blockNodeFromMdast(mdast)
      expect(result._tag).toBe("Heading")
      expect((result as Heading).level).toBe(3)
    })

    it("CodeBlock roundtrips through MDAST", () => {
      const original = new CodeBlock({ code: "x = 1", language: "py" })
      const mdast = blockNodeToMdast(original)
      const result = blockNodeFromMdast(mdast)
      expect(result._tag).toBe("CodeBlock")
      expect((result as CodeBlock).code).toBe("x = 1")
      expect((result as CodeBlock).language).toBe("py")
    })
  })
})
