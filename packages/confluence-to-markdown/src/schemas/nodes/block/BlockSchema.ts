/**
 * Transform schemas for block nodes (Hast <-> AST <-> Mdast).
 *
 * Provides bidirectional transforms between HAST elements, AST block nodes,
 * and MDAST block content for structural document elements.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import {
  type BlockNode,
  type BlockQuote,
  CodeBlock,
  Heading,
  Image,
  type List,
  type ListItem,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  type TaskItem,
  type TaskList,
  ThematicBreak,
  UnsupportedBlock
} from "../../../ast/BlockNode.js"
import type { InlineNode } from "../../../ast/InlineNode.js"
import type { HastElement, HastNode, HastText } from "../../hast/index.js"
import { getTextContent, isHastElement, isHastText, makeHastElement, makeHastText } from "../../hast/index.js"
import type { MdastBlockContent } from "../../mdast/index.js"
import { makeMdastCode, makeMdastHeading, makeMdastParagraph } from "../../mdast/index.js"
import { inlineNodeFromHastElement, inlineNodeToHast, inlineNodeToMdast, textFromHastText } from "../inline/index.js"

/**
 * Parse HAST children to inline nodes.
 */
const parseHastChildrenToInline = (
  children: ReadonlyArray<HastNode>
): Effect.Effect<ReadonlyArray<InlineNode>, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const nodes: Array<InlineNode> = []
    const parseChildren = (
      c: ReadonlyArray<HastNode>
    ): Effect.Effect<ReadonlyArray<InlineNode>, ParseResult.ParseError> => parseHastChildrenToInline(c)

    for (const child of children) {
      if (isHastText(child)) {
        if ((child as HastText).value.trim() || nodes.length > 0) {
          nodes.push(textFromHastText(child))
        }
      } else if (isHastElement(child)) {
        const node = yield* inlineNodeFromHastElement(child, parseChildren)
        if (node) nodes.push(node)
      }
    }
    return nodes
  })

/**
 * Convert HAST element to AST block node.
 */
export const blockNodeFromHastElement = (
  element: HastElement
): Effect.Effect<BlockNode | null, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const tagName = element.tagName.toLowerCase()

    // Heading
    if (/^h[1-6]$/.test(tagName)) {
      const levelStr = tagName[1]
      if (!levelStr) return null
      const level = parseInt(levelStr) as 1 | 2 | 3 | 4 | 5 | 6
      const children = yield* parseHastChildrenToInline(element.children)
      return new Heading({ level, children })
    }

    // Paragraph
    if (tagName === "p") {
      const children = yield* parseHastChildrenToInline(element.children)
      const style = element.properties?.style as string | undefined
      let alignment: "left" | "center" | "right" | undefined
      let indent: number | undefined

      if (style) {
        const alignMatch = style.match(/text-align:\s*(left|center|right)/)
        if (alignMatch?.[1]) {
          alignment = alignMatch[1] as "left" | "center" | "right"
        }
        const marginMatch = style.match(/margin-left:\s*(\d+(?:\.\d+)?)\s*px/)
        if (marginMatch?.[1]) {
          indent = parseFloat(marginMatch[1])
        }
      }

      if (alignment !== undefined || indent !== undefined) {
        return new Paragraph({
          children,
          ...(alignment !== undefined ? { alignment } : {}),
          ...(indent !== undefined ? { indent } : {})
        })
      }
      return new Paragraph({ children })
    }

    // Code block
    if (tagName === "pre") {
      const codeEl = element.children.find(
        (c): c is HastElement => isHastElement(c) && c.tagName === "code"
      )
      const code = codeEl ? getTextContent(codeEl) : getTextContent(element)
      const language = (element.properties?.["dataLanguage"] as string) || undefined
      return new CodeBlock({ code, language })
    }

    // Thematic break
    if (tagName === "hr") {
      return new ThematicBreak({})
    }

    // Image
    if (tagName === "img") {
      const src = element.properties?.src as string | undefined
      const dataAttachment = element.properties?.["dataAttachment"] as string | undefined
      const dataAlign = element.properties?.["dataAlign"] as string | undefined
      const dataWidth = element.properties?.["dataWidth"] as string | undefined
      const alt = (element.properties?.alt as string) || undefined

      if (dataAttachment) {
        return new Image({
          attachment: { filename: dataAttachment },
          alt,
          ...(dataAlign ? { align: dataAlign } : {}),
          ...(dataWidth ? { width: parseInt(dataWidth) } : {})
        })
      }

      if (!src) return null
      return new Image({
        src,
        alt,
        title: (element.properties?.title as string) || undefined
      })
    }

    // Table
    if (tagName === "table") {
      return yield* parseTable(element)
    }

    // Task list
    if (tagName === "ul" && element.properties?.["dataMacro"] === "task-list") {
      return yield* parseTaskList(element)
    }

    // Lists
    if (tagName === "ul" || tagName === "ol") {
      return yield* parseList(element, tagName === "ol")
    }

    // Block quote
    if (tagName === "blockquote") {
      const children = yield* parseHastChildrenToSimpleBlocks(element.children)
      return {
        _tag: "BlockQuote" as const,
        version: 1,
        children
      } satisfies BlockQuote
    }

    // Unknown block element
    return new UnsupportedBlock({
      rawHtml: hastElementToHtml(element),
      source: "confluence"
    })
  })

/**
 * Convert AST block node to HAST element.
 */
export const blockNodeToHast = (node: BlockNode): HastElement => {
  switch (node._tag) {
    case "Heading":
      return makeHastElement(
        `h${node.level}`,
        {},
        node.children.map(inlineNodeToHast)
      )
    case "Paragraph": {
      const style = [
        node.alignment ? `text-align: ${node.alignment}` : "",
        node.indent ? `margin-left: ${node.indent}px` : ""
      ].filter(Boolean).join("; ")
      return makeHastElement(
        "p",
        style ? { style } : {},
        node.children.map(inlineNodeToHast)
      )
    }
    case "CodeBlock":
      return makeHastElement(
        "pre",
        node.language ? { dataLanguage: node.language } : {},
        [makeHastElement("code", {}, [makeHastText(node.code)])]
      )
    case "ThematicBreak":
      return makeHastElement("hr")
    case "Image":
      if (node.attachment) {
        return makeHastElement("img", {
          dataAttachment: node.attachment.filename,
          ...(node.alt ? { alt: node.alt } : {}),
          ...(node.align ? { dataAlign: node.align } : {}),
          ...(node.width ? { dataWidth: String(node.width) } : {})
        })
      }
      return makeHastElement("img", {
        src: node.src ?? "",
        ...(node.alt ? { alt: node.alt } : {}),
        ...(node.title ? { title: node.title } : {})
      })
    case "Table":
      return tableToHast(node)
    case "BlockQuote":
      return makeHastElement("blockquote", {}, node.children.map(blockNodeToHast))
    case "List":
      return listToHast(node)
    case "TaskList":
      return taskListToHast(node)
    case "UnsupportedBlock":
      return makeHastElement("div", { dangerouslySetInnerHTML: node.rawHtml ?? node.rawMarkdown ?? "" })
  }
}

/**
 * Convert AST block node to MDAST block content.
 */
export const blockNodeToMdast = (node: BlockNode): MdastBlockContent => {
  switch (node._tag) {
    case "Heading":
      return makeMdastHeading(node.level, node.children.map(inlineNodeToMdast))
    case "Paragraph":
      return makeMdastParagraph(node.children.map(inlineNodeToMdast))
    case "CodeBlock":
      return makeMdastCode(node.code, node.language)
    case "ThematicBreak":
      return { type: "thematicBreak" }
    case "Image":
      // MDAST doesn't have block images at root - wrap in paragraph
      return makeMdastParagraph([{
        type: "image",
        url: node.src ?? node.attachment?.filename ?? "",
        alt: node.alt ?? null,
        title: node.title ?? null
      }])
    case "Table":
      return tableToMdast(node)
    case "BlockQuote":
      return {
        type: "blockquote",
        children: node.children.map(blockNodeToMdast)
      }
    case "List":
      return listToMdast(node)
    case "TaskList":
      // Convert to list with checkboxes
      return {
        type: "list",
        ordered: false,
        children: node.children.map((item) => ({
          type: "listItem",
          checked: item.status === "complete",
          children: [{
            type: "paragraph",
            children: item.body.map(inlineNodeToMdast)
          }]
        }))
      }
    case "UnsupportedBlock":
      return {
        type: "html",
        value: node.rawHtml ?? node.rawMarkdown ?? ""
      }
  }
}

/**
 * Convert MDAST block content to AST block node.
 */
export const blockNodeFromMdast = (node: MdastBlockContent): BlockNode => {
  switch (node.type) {
    case "heading":
      return new Heading({
        level: node.depth,
        children: [] // Would need full inline conversion
      })
    case "paragraph":
      return new Paragraph({ children: [] })
    case "code":
      return new CodeBlock({ code: node.value, language: node.lang })
    case "thematicBreak":
      return new ThematicBreak({})
    case "blockquote":
      return {
        _tag: "BlockQuote",
        version: 1,
        children: node.children.map(blockNodeFromMdast)
      } as BlockQuote
    case "list":
      return {
        _tag: "List",
        version: 1,
        ordered: node.ordered ?? false,
        start: node.start,
        children: node.children.map((item) => ({
          _tag: "ListItem" as const,
          checked: item.checked ?? undefined,
          children: [] // Would need full block conversion
        }))
      } as List
    case "table":
      return new Table({ rows: [] })
    case "html":
      return new UnsupportedBlock({ rawMarkdown: node.value, source: "markdown" })
    default:
      return new UnsupportedBlock({ rawMarkdown: JSON.stringify(node), source: "markdown" })
  }
}

// Helper functions

/**
 * Parse table element.
 */
const parseTable = (element: HastElement): Effect.Effect<Table, ParseResult.ParseError> =>
  Effect.gen(function*() {
    let header: TableRow | undefined
    const rows: Array<TableRow> = []

    for (const child of element.children) {
      if (!isHastElement(child)) continue

      if (child.tagName === "thead") {
        const tr = child.children.find(
          (c): c is HastElement => isHastElement(c) && c.tagName === "tr"
        )
        if (tr) {
          header = yield* parseTableRow(tr, true)
        }
      } else if (child.tagName === "tbody") {
        for (const row of child.children) {
          if (isHastElement(row) && row.tagName === "tr") {
            const allTh = row.children
              .filter(isHastElement)
              .every((c) => c.tagName === "th")
            if (allTh && !header && rows.length === 0) {
              header = yield* parseTableRow(row, true)
            } else {
              rows.push(yield* parseTableRow(row, false))
            }
          }
        }
      } else if (child.tagName === "tr") {
        rows.push(yield* parseTableRow(child, false))
      }
    }

    return new Table({ header, rows })
  })

/**
 * Parse table row.
 */
const parseTableRow = (
  element: HastElement,
  isHeader: boolean
): Effect.Effect<TableRow, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const cells: Array<TableCell> = []
    for (const child of element.children) {
      if (isHastElement(child) && (child.tagName === "td" || child.tagName === "th")) {
        const cellIsHeader = isHeader || child.tagName === "th"
        const children = yield* parseCellContent(child.children)
        cells.push(new TableCell({ isHeader: cellIsHeader, children }))
      }
    }
    return new TableRow({ cells })
  })

/**
 * Parse cell content, unwrapping single <p> elements.
 */
const parseCellContent = (
  children: ReadonlyArray<HastNode>
): Effect.Effect<ReadonlyArray<InlineNode>, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const elementChildren = children.filter((c) => {
      if (isHastElement(c)) return true
      if (isHastText(c) && c.value.trim()) return true
      return false
    })

    if (elementChildren.length === 1) {
      const first = elementChildren[0]
      if (first && isHastElement(first) && first.tagName === "p") {
        return yield* parseHastChildrenToInline(first.children)
      }
    }

    return yield* parseHastChildrenToInline(children)
  })

/**
 * Parse task list element.
 */
const parseTaskList = (element: HastElement): Effect.Effect<TaskList, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const items: Array<TaskItem> = []

    for (const child of element.children) {
      if (isHastElement(child) && child.tagName === "li") {
        const id = (child.properties?.["dataTaskId"] as string) || ""
        const uuid = (child.properties?.["dataTaskUuid"] as string) || ""
        const status = (child.properties?.["dataTaskStatus"] as string) === "complete"
          ? "complete" as const
          : "incomplete" as const
        const body = yield* parseHastChildrenToInline(child.children)

        items.push({
          _tag: "TaskItem",
          id,
          uuid,
          status,
          body
        })
      }
    }

    return {
      _tag: "TaskList" as const,
      version: 1,
      children: items
    }
  })

/**
 * Parse list element.
 */
const parseList = (
  element: HastElement,
  ordered: boolean
): Effect.Effect<List, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const items: Array<ListItem> = []
    const startProp = element.properties?.start
    const start = ordered && startProp ? parseInt(String(startProp)) : undefined

    for (const child of element.children) {
      if (isHastElement(child) && child.tagName === "li") {
        const children = yield* parseListItemContent(child.children)
        const checkbox = child.children.find(
          (c): c is HastElement =>
            isHastElement(c) &&
            c.tagName === "input" &&
            c.properties?.type === "checkbox"
        )
        const checked = checkbox ? (checkbox.properties?.checked === true) : undefined
        if (checked !== undefined) {
          items.push({ _tag: "ListItem", checked, children })
        } else {
          items.push({ _tag: "ListItem", children })
        }
      }
    }

    if (start !== undefined) {
      return { _tag: "List" as const, version: 1, ordered, start, children: items }
    }
    return { _tag: "List" as const, version: 1, ordered, children: items }
  })

type SimpleBlock = Heading | Paragraph | CodeBlock | ThematicBreak | Image | Table | UnsupportedBlock

/**
 * Parse HAST children to simple block nodes.
 */
const parseHastChildrenToSimpleBlocks = (
  children: ReadonlyArray<HastNode>
): Effect.Effect<Array<SimpleBlock>, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const blocks: Array<SimpleBlock> = []
    for (const child of children) {
      if (isHastElement(child)) {
        const tagName = child.tagName.toLowerCase()

        if (/^h[1-6]$/.test(tagName)) {
          const levelStr = tagName[1]
          if (levelStr) {
            const level = parseInt(levelStr) as 1 | 2 | 3 | 4 | 5 | 6
            const inlineChildren = yield* parseHastChildrenToInline(child.children)
            blocks.push(new Heading({ level, children: inlineChildren }))
          }
        } else if (tagName === "p") {
          const inlineChildren = yield* parseHastChildrenToInline(child.children)
          blocks.push(new Paragraph({ children: inlineChildren }))
        } else if (tagName === "pre") {
          const codeEl = child.children.find(
            (c): c is HastElement => isHastElement(c) && c.tagName === "code"
          )
          const code = codeEl ? getTextContent(codeEl) : getTextContent(child)
          blocks.push(new CodeBlock({ code }))
        } else if (tagName === "hr") {
          blocks.push(new ThematicBreak({}))
        } else if (tagName === "img") {
          const src = child.properties?.src as string | undefined
          if (src) blocks.push(new Image({ src }))
        } else if (tagName === "table") {
          blocks.push(yield* parseTable(child))
        } else {
          blocks.push(new UnsupportedBlock({ rawHtml: hastElementToHtml(child), source: "confluence" }))
        }
      }
    }
    return blocks
  })

/**
 * Parse list item content.
 */
const parseListItemContent = (
  children: ReadonlyArray<HastNode>
): Effect.Effect<Array<SimpleBlock>, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const blocks: Array<SimpleBlock> = []

    const hasDirectInlineContent = children.some((child) => {
      if (isHastText(child)) {
        return child.value.trim() !== ""
      }
      if (isHastElement(child)) {
        const tagName = child.tagName.toLowerCase()
        return ["a", "strong", "em", "b", "i", "u", "code", "span", "del", "sub", "sup"].includes(tagName)
      }
      return false
    })

    if (hasDirectInlineContent) {
      const inlineChildren = yield* parseHastChildrenToInline(children)
      if (inlineChildren.length > 0) {
        blocks.push(new Paragraph({ children: inlineChildren }))
      }
      return blocks
    }

    for (const child of children) {
      if (!isHastElement(child)) continue
      const tagName = child.tagName.toLowerCase()

      if (tagName === "p") {
        const inlineChildren = yield* parseHastChildrenToInline(child.children)
        blocks.push(new Paragraph({ children: inlineChildren }))
      } else if (tagName === "ul" || tagName === "ol") {
        blocks.push(new UnsupportedBlock({ rawHtml: hastElementToHtml(child), source: "confluence" }))
      } else if (tagName === "pre") {
        const codeEl = child.children.find(
          (c): c is HastElement => isHastElement(c) && c.tagName === "code"
        )
        const code = codeEl ? getTextContent(codeEl) : getTextContent(child)
        blocks.push(new CodeBlock({ code }))
      } else if (tagName === "hr") {
        blocks.push(new ThematicBreak({}))
      } else if (tagName === "img") {
        const src = child.properties?.src as string | undefined
        if (src) blocks.push(new Image({ src }))
      } else if (tagName === "table") {
        blocks.push(yield* parseTable(child))
      } else if (/^h[1-6]$/.test(tagName)) {
        const levelStr = tagName[1]
        if (levelStr) {
          const level = parseInt(levelStr) as 1 | 2 | 3 | 4 | 5 | 6
          const inlineChildren = yield* parseHastChildrenToInline(child.children)
          blocks.push(new Heading({ level, children: inlineChildren }))
        }
      }
    }

    return blocks
  })

/**
 * Convert table to HAST.
 */
const tableToHast = (table: Table): HastElement => {
  const rows = table.rows.map((row) =>
    makeHastElement(
      "tr",
      {},
      row.cells.map((cell) =>
        makeHastElement(
          cell.isHeader ? "th" : "td",
          {},
          cell.children.map(inlineNodeToHast)
        )
      )
    )
  )

  if (table.header) {
    const headerRow = makeHastElement(
      "tr",
      {},
      table.header.cells.map((cell) => makeHastElement("th", {}, cell.children.map(inlineNodeToHast)))
    )
    return makeHastElement("table", {}, [
      makeHastElement("thead", {}, [headerRow]),
      makeHastElement("tbody", {}, rows)
    ])
  }

  return makeHastElement("table", {}, [makeHastElement("tbody", {}, rows)])
}

/**
 * Convert table to MDAST.
 */
const tableToMdast = (table: Table): MdastBlockContent => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: Array<any> = []

  if (table.header) {
    rows.push({
      type: "tableRow",
      children: table.header.cells.map((cell) => ({
        type: "tableCell",
        children: cell.children.map(inlineNodeToMdast)
      }))
    })
  }

  for (const row of table.rows) {
    rows.push({
      type: "tableRow",
      children: row.cells.map((cell) => ({
        type: "tableCell",
        children: cell.children.map(inlineNodeToMdast)
      }))
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { type: "table", children: rows } as any
}

/**
 * Convert list to HAST.
 */
const listToHast = (list: List): HastElement => {
  const items = list.children.map((item) => makeHastElement("li", {}, item.children.map(blockNodeToHast)))
  return makeHastElement(
    list.ordered ? "ol" : "ul",
    list.start !== undefined ? { start: String(list.start) } : {},
    items
  )
}

/**
 * Convert list to MDAST.
 */
const listToMdast = (list: List): MdastBlockContent => {
  const result = {
    type: "list" as const,
    ordered: list.ordered,
    children: list.children.map((item) => ({
      type: "listItem" as const,
      checked: item.checked ?? null,
      children: item.children.map(blockNodeToMdast)
    }))
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (list.start !== undefined) (result as any).start = list.start
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result as any
}

/**
 * Convert task list to HAST.
 */
const taskListToHast = (taskList: TaskList): HastElement => {
  const items = taskList.children.map((item) =>
    makeHastElement(
      "li",
      {
        dataTaskId: item.id,
        dataTaskUuid: item.uuid,
        dataTaskStatus: item.status
      },
      item.body.map(inlineNodeToHast)
    )
  )
  return makeHastElement("ul", { dataMacro: "task-list" }, items)
}

/**
 * Convert HAST element to HTML string.
 */
const hastElementToHtml = (element: HastElement): string => {
  const props = Object.entries(element.properties || {})
    .map(([k, v]) => {
      const attrName = k.replace(/([A-Z])/g, "-$1").toLowerCase()
      return `${attrName}="${String(v)}"`
    })
    .join(" ")
  const openTag = props ? `<${element.tagName} ${props}>` : `<${element.tagName}>`
  const closeTag = `</${element.tagName}>`
  const content = element.children
    .map((c) => {
      if (isHastText(c)) return c.value
      if (isHastElement(c)) return hastElementToHtml(c)
      return ""
    })
    .join("")
  return `${openTag}${content}${closeTag}`
}

/**
 * Schema-based HAST to BlockNode array transform.
 *
 * @category Schemas
 */
export const BlockNodesFromHast = Schema.transformOrFail(
  Schema.Array(Schema.Unknown),
  Schema.Array(Schema.Any),
  {
    strict: false,
    decode: (hastNodes, _options, ast) =>
      Effect.gen(function*() {
        const results: Array<BlockNode> = []

        for (const hastNode of hastNodes) {
          if (isHastElement(hastNode as HastNode)) {
            const node = yield* blockNodeFromHastElement(hastNode as HastElement)
            if (node) results.push(node)
          }
        }

        return results
      }).pipe(
        Effect.mapError((e) =>
          e instanceof ParseResult.ParseError
            ? e.issue
            : new ParseResult.Type(ast, hastNodes, String(e))
        )
      ),
    encode: (nodes, _options, _ast) => Effect.succeed(nodes.map(blockNodeToHast) as ReadonlyArray<unknown>)
  }
)

/**
 * Schema-based MDAST to BlockNode array transform.
 *
 * @category Schemas
 */
export const BlockNodesFromMdast = Schema.transformOrFail(
  Schema.Array(Schema.Unknown),
  Schema.Array(Schema.Any),
  {
    strict: false,
    decode: (mdastNodes, _options, _ast) =>
      Effect.succeed(mdastNodes.map((n) => blockNodeFromMdast(n as MdastBlockContent))),
    encode: (nodes, _options, _ast) => Effect.succeed(nodes.map(blockNodeToMdast) as ReadonlyArray<unknown>)
  }
)
