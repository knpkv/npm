import { describe, expect, it } from "@effect/vitest"
import { Paragraph } from "../../../../src/ast/BlockNode.js"
import { Text } from "../../../../src/ast/InlineNode.js"
import type { CodeMacro, ExpandMacro, InfoPanel, StatusMacro, TocMacro } from "../../../../src/ast/MacroNode.js"
import { macroNodeToHast, macroNodeToMdast } from "../../../../src/schemas/nodes/macro/index.js"

describe("MacroSchema", () => {
  describe("macroNodeToHast", () => {
    it("converts InfoPanel to hast div with data attributes", () => {
      const panel: InfoPanel = {
        _tag: "InfoPanel",
        version: 1,
        panelType: "warning",
        title: "Important",
        children: [new Paragraph({ children: [new Text({ value: "Content" })] })]
      }
      const result = macroNodeToHast(panel)
      expect(result._tag).toBe("element")
      expect(result.tagName).toBe("div")
      expect(result.properties?.dataMacro).toBe("warning")
      expect(result.properties?.dataTitle).toBe("Important")
    })

    it("converts ExpandMacro to hast details element", () => {
      const expand: ExpandMacro = {
        _tag: "ExpandMacro",
        version: 1,
        title: "Click to expand",
        children: [new Paragraph({ children: [new Text({ value: "Hidden" })] })]
      }
      const result = macroNodeToHast(expand)
      expect(result._tag).toBe("element")
      expect(result.tagName).toBe("details")
    })

    it("converts TocMacro to hast nav element", () => {
      const toc: TocMacro = {
        _tag: "TocMacro",
        version: 1,
        minLevel: 2,
        maxLevel: 4
      }
      const result = macroNodeToHast(toc)
      expect(result._tag).toBe("element")
      expect(result.tagName).toBe("nav")
      expect(result.properties?.dataMacro).toBe("toc")
      expect(result.properties?.dataMin).toBe("2")
      expect(result.properties?.dataMax).toBe("4")
    })

    it("converts CodeMacro to hast pre/code elements", () => {
      const code: CodeMacro = {
        _tag: "CodeMacro",
        version: 1,
        language: "typescript",
        code: "const x = 1",
        lineNumbers: false,
        collapse: false
      }
      const result = macroNodeToHast(code)
      expect(result._tag).toBe("element")
      expect(result.tagName).toBe("pre")
      expect(result.properties?.dataLanguage).toBe("typescript")
    })

    it("converts StatusMacro to hast span element", () => {
      const status: StatusMacro = {
        _tag: "StatusMacro",
        version: 1,
        text: "Done",
        color: "Green"
      }
      const result = macroNodeToHast(status)
      expect(result._tag).toBe("element")
      expect(result.tagName).toBe("span")
      expect(result.properties?.dataMacro).toBe("status")
      expect(result.properties?.dataColor).toBe("Green")
    })
  })

  describe("macroNodeToMdast", () => {
    it("converts InfoPanel to mdast html with container syntax", () => {
      const panel: InfoPanel = {
        _tag: "InfoPanel",
        version: 1,
        panelType: "info",
        children: [new Paragraph({ children: [new Text({ value: "Note content" })] })]
      }
      const result = macroNodeToMdast(panel)
      expect(result.type).toBe("html")
      expect((result as { value: string }).value).toContain(":::info")
    })

    it("converts ExpandMacro to mdast html with details element", () => {
      const expand: ExpandMacro = {
        _tag: "ExpandMacro",
        version: 1,
        title: "More info",
        children: []
      }
      const result = macroNodeToMdast(expand)
      expect(result.type).toBe("html")
      expect((result as { value: string }).value).toContain("<details>")
      expect((result as { value: string }).value).toContain("More info")
    })

    it("converts TocMacro to mdast html with toc marker", () => {
      const toc: TocMacro = {
        _tag: "TocMacro",
        version: 1
      }
      const result = macroNodeToMdast(toc)
      expect(result.type).toBe("html")
      expect((result as { value: string }).value).toBe("[[toc]]")
    })

    it("converts CodeMacro to mdast code", () => {
      const code: CodeMacro = {
        _tag: "CodeMacro",
        version: 1,
        language: "py",
        code: "print(1)",
        lineNumbers: false,
        collapse: false
      }
      const result = macroNodeToMdast(code)
      expect(result.type).toBe("code")
      expect((result as { value: string }).value).toBe("print(1)")
    })

    it("converts StatusMacro to mdast paragraph with badge text", () => {
      const status: StatusMacro = {
        _tag: "StatusMacro",
        version: 1,
        text: "In Progress",
        color: "Blue"
      }
      const result = macroNodeToMdast(status)
      expect(result.type).toBe("paragraph")
    })
  })
})
