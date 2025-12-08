/**
 * Transform schemas for macro nodes (Hast <-> AST).
 *
 * Provides transforms for Confluence-specific macro elements like info panels,
 * expand sections, TOC, and status badges.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import type * as ParseResult from "effect/ParseResult"
import type {
  BlockNode,
  CodeBlock,
  Heading,
  Image,
  Paragraph,
  Table,
  ThematicBreak,
  UnsupportedBlock
} from "../../../ast/BlockNode.js"
import {
  type CodeMacro,
  type ExpandMacro,
  type InfoPanel,
  type MacroNode,
  PanelTypes,
  type StatusMacro,
  type TocMacro
} from "../../../ast/MacroNode.js"
import type { HastElement, HastNode } from "../../hast/index.js"
import { getTextContent, isHastElement, makeHastElement, makeHastText } from "../../hast/index.js"
import type { MdastBlockContent } from "../../mdast/index.js"
import { makeMdastCode, makeMdastParagraph, makeMdastText } from "../../mdast/index.js"
import { blockNodeToHast, blockNodeToMdast } from "../block/index.js"

type SimpleBlock = Heading | Paragraph | CodeBlock | ThematicBreak | Image | Table | UnsupportedBlock

/**
 * Convert HAST element to AST macro node.
 */
export const macroNodeFromHastElement = (
  element: HastElement,
  parseBlockChildren: (
    children: ReadonlyArray<HastNode>
  ) => Effect.Effect<ReadonlyArray<BlockNode>, ParseResult.ParseError>
): Effect.Effect<MacroNode | null, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const tagName = element.tagName.toLowerCase()

    // Info/warning/note panels
    if (tagName === "div" && element.properties?.["dataMacro"]) {
      const macro = element.properties["dataMacro"] as string
      if ((PanelTypes as ReadonlyArray<string>).includes(macro)) {
        const children = yield* parseBlockChildren(element.children)
        // Cast to SimpleBlock[] - at runtime only simple blocks are parsed for panel children
        return {
          _tag: "InfoPanel" as const,
          version: 1,
          panelType: macro as (typeof PanelTypes)[number],
          title: (element.properties["dataTitle"] as string) || undefined,
          children: children as ReadonlyArray<SimpleBlock>
        } satisfies InfoPanel
      }
    }

    // Expand/details
    if (tagName === "details") {
      const summary = element.children.find(
        (c): c is HastElement => isHastElement(c) && c.tagName === "summary"
      )
      const title = summary ? getTextContent(summary) : undefined
      const contentChildren = element.children.filter(
        (c) => !(isHastElement(c) && c.tagName === "summary")
      )
      const children = yield* parseBlockChildren(contentChildren)
      // Cast to SimpleBlock[] - at runtime only simple blocks are parsed for expand children
      return {
        _tag: "ExpandMacro" as const,
        version: 1,
        title,
        children: children as ReadonlyArray<SimpleBlock>
      } satisfies ExpandMacro
    }

    // TOC
    if (tagName === "nav" && element.properties?.["dataMacro"] === "toc") {
      const minStr = element.properties["dataMin"] as string | undefined
      const maxStr = element.properties["dataMax"] as string | undefined
      return {
        _tag: "TocMacro" as const,
        version: 1,
        minLevel: minStr ? parseInt(minStr) : undefined,
        maxLevel: maxStr ? parseInt(maxStr) : undefined
      } satisfies TocMacro
    }

    // Code macro (from preprocessed data)
    if (tagName === "pre" && element.properties?.["dataMacro"] === "code") {
      const codeEl = element.children.find(
        (c): c is HastElement => isHastElement(c) && c.tagName === "code"
      )
      const code = codeEl ? getTextContent(codeEl) : getTextContent(element)
      const language = (element.properties["dataLanguage"] as string) || undefined
      return {
        _tag: "CodeMacro" as const,
        version: 1,
        language,
        code,
        lineNumbers: false,
        collapse: false
      } satisfies CodeMacro
    }

    // Status macro
    if (tagName === "span" && element.properties?.["dataMacro"] === "status") {
      const color = (element.properties["dataColor"] as string) || "Grey"
      const text = getTextContent(element)
      return {
        _tag: "StatusMacro" as const,
        version: 1,
        text,
        color: normalizeStatusColor(color)
      } satisfies StatusMacro
    }

    return null
  })

/**
 * Normalize status color to allowed values.
 */
const normalizeStatusColor = (color: string): "Grey" | "Red" | "Yellow" | "Green" | "Blue" => {
  const normalized = color.toLowerCase()
  switch (normalized) {
    case "red":
      return "Red"
    case "yellow":
      return "Yellow"
    case "green":
      return "Green"
    case "blue":
      return "Blue"
    default:
      return "Grey"
  }
}

/**
 * Convert AST macro node to HAST element.
 */
export const macroNodeToHast = (node: MacroNode): HastElement => {
  switch (node._tag) {
    case "InfoPanel":
      return makeHastElement(
        "div",
        {
          dataMacro: node.panelType,
          ...(node.title ? { dataTitle: node.title } : {})
        },
        node.children.map(blockNodeToHast)
      )
    case "ExpandMacro":
      return makeHastElement(
        "details",
        { dataMacro: "expand" },
        [
          ...(node.title ? [makeHastElement("summary", {}, [makeHastText(node.title)])] : []),
          ...node.children.map(blockNodeToHast)
        ]
      )
    case "TocMacro":
      return makeHastElement("nav", {
        dataMacro: "toc",
        ...(node.minLevel !== undefined ? { dataMin: String(node.minLevel) } : {}),
        ...(node.maxLevel !== undefined ? { dataMax: String(node.maxLevel) } : {})
      })
    case "CodeMacro":
      return makeHastElement(
        "pre",
        {
          dataMacro: "code",
          ...(node.language ? { dataLanguage: node.language } : {})
        },
        [makeHastElement("code", {}, [makeHastText(node.code)])]
      )
    case "StatusMacro":
      return makeHastElement(
        "span",
        { dataMacro: "status", dataColor: node.color },
        [makeHastText(node.text)]
      )
  }
}

/**
 * Convert AST macro node to MDAST block content.
 */
export const macroNodeToMdast = (node: MacroNode): MdastBlockContent => {
  switch (node._tag) {
    case "InfoPanel":
      // Render as container syntax with children
      return {
        type: "html",
        value: `:::${node.panelType}${node.title ? ` ${node.title}` : ""}\n${
          node.children.map((c) => mdastToString(blockNodeToMdast(c))).join("\n")
        }\n:::`
      }
    case "ExpandMacro":
      return {
        type: "html",
        value: `<details>\n<summary>${node.title ?? ""}</summary>\n${
          node.children.map((c) => mdastToString(blockNodeToMdast(c))).join("\n")
        }\n</details>`
      }
    case "TocMacro":
      return {
        type: "html",
        value: "[[toc]]"
      }
    case "CodeMacro":
      return makeMdastCode(node.code, node.language)
    case "StatusMacro":
      // Render as badge-like text
      return makeMdastParagraph([makeMdastText(`[${node.text}]`)])
  }
}

/**
 * Convert MDAST to string (simple implementation).
 */
const mdastToString = (node: MdastBlockContent): string => {
  switch (node.type) {
    case "paragraph":
      return node.children.map((c) => {
        if (c.type === "text") return c.value
        if (c.type === "inlineCode") return `\`${c.value}\``
        return ""
      }).join("")
    case "heading":
      return "#".repeat(node.depth) + " " + node.children.map((c) => {
        if (c.type === "text") return c.value
        return ""
      }).join("")
    case "code":
      return "```" + (node.lang ?? "") + "\n" + node.value + "\n```"
    case "thematicBreak":
      return "---"
    case "html":
      return node.value
    default:
      return ""
  }
}
