/**
 * Parser for Confluence storage format (HTML) to AST.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import rehypeParse from "rehype-parse"
import { unified } from "unified"
import {
  CodeBlock,
  Heading,
  Image,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  type TaskItem,
  type TaskList,
  ThematicBreak,
  UnsupportedBlock
} from "../ast/BlockNode.js"
import { type Document, type DocumentNode, makeDocument } from "../ast/Document.js"
import {
  ColoredText,
  DateTime,
  Emoticon,
  Emphasis,
  Highlight,
  InlineCode,
  type InlineNode,
  LineBreak,
  Link,
  Strikethrough,
  Strong,
  Subscript,
  Superscript,
  Text,
  Underline,
  UnsupportedInline,
  UserMention
} from "../ast/InlineNode.js"
import { type ExpandMacro, type InfoPanel, PanelTypes, type TocMacro } from "../ast/MacroNode.js"
import { ParseError } from "../SchemaConverterError.js"
import { PreprocessedHtmlFromConfluence } from "../schemas/preprocessing/index.js"

// Hast types (inline to avoid dependency)
interface HastText {
  type: "text"
  value: string
}

interface HastElement {
  type: "element"
  tagName: string
  properties?: Record<string, unknown>
  children: Array<HastNode>
}

interface HastRoot {
  type: "root"
  children: Array<HastNode>
}

type HastNode = HastText | HastElement | HastRoot | { type: string }

/**
 * Parse Confluence storage format HTML to Document AST.
 *
 * @example
 * ```typescript
 * import { parseConfluenceHtml } from "@knpkv/confluence-to-markdown/parsers/ConfluenceParser"
 * import { Effect } from "effect"
 *
 * Effect.gen(function* () {
 *   const doc = yield* parseConfluenceHtml("<h1>Title</h1><p>Content</p>")
 *   console.log(doc.children.length) // 2
 * })
 * ```
 *
 * @category Parsers
 */
export const parseConfluenceHtml = (html: string): Effect.Effect<Document, ParseError> =>
  Effect.gen(function*() {
    // Pre-process Confluence macros (includes size validation)
    const preprocessed = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html).pipe(
      Effect.mapError((error) =>
        new ParseError({
          source: "confluence",
          message: `Preprocessing error: ${error.message}`,
          rawContent: html.slice(0, 200)
        })
      )
    )

    // Parse HTML to hast
    const hast = yield* Effect.try({
      try: () => unified().use(rehypeParse, { fragment: true }).parse(preprocessed) as HastRoot,
      catch: (error) =>
        new ParseError({
          source: "confluence",
          message: `HTML parse error: ${error instanceof Error ? error.message : String(error)}`,
          rawContent: html.slice(0, 200)
        })
    })

    // Convert hast to AST
    const children = yield* hastToDocumentNodes(hast)
    // Store original HTML for 1-to-1 roundtrip
    return makeDocument(children, html)
  })

/**
 * Convert hast Root to document nodes.
 */
const hastToDocumentNodes = (root: HastRoot): Effect.Effect<Array<DocumentNode>, ParseError> =>
  Effect.gen(function*() {
    const nodes: Array<DocumentNode> = []
    for (const child of root.children) {
      if (child.type === "element") {
        const el = child as HastElement
        // Check for marker div containing a cf: comment
        if (el.tagName === "div" && el.properties?.["dataCfMarker"] !== undefined) {
          const commentChild = el.children.find((c) => c.type === "comment")
          if (commentChild) {
            const comment = (commentChild as { type: "comment"; value: string }).value
            const node = yield* parseCommentNode(comment)
            if (node !== null) nodes.push(node)
          }
        } else {
          const node = yield* hastElementToNode(el)
          if (node !== null) nodes.push(node)
        }
      } else if (child.type === "comment") {
        // Handle cf: comment-encoded elements at root level
        const comment = (child as { type: "comment"; value: string }).value
        const node = yield* parseCommentNode(comment)
        if (node !== null) nodes.push(node)
      }
    }
    return nodes
  })

/**
 * Parse comment-encoded elements (decision lists, layout markers, etc).
 */
const parseCommentNode = (comment: string): Effect.Effect<DocumentNode | null, ParseError> =>
  Effect.gen(function*() {
    // Decision list: cf:decision:localId;state;content|localId;state;content
    const decisionMatch = comment.match(/^cf:decision:(.*)$/)
    if (decisionMatch) {
      const itemsStr = decisionMatch[1] ?? ""
      // Return as UnsupportedBlock with the encoded comment for roundtrip
      return new UnsupportedBlock({
        rawHtml: `<!--cf:decision:${itemsStr}-->`,
        source: "confluence"
      })
    }

    // Layout markers - these are structural markers, preserve for roundtrip
    // cf:layout-start, cf:layout-end
    if (comment === "cf:layout-start" || comment === "cf:layout-end") {
      return new UnsupportedBlock({
        rawHtml: `<!--${comment}-->`,
        source: "confluence"
      })
    }

    // cf:section:index;type;breakoutMode;breakoutWidth;cellCount
    const sectionMatch = comment.match(/^cf:section:(\d+);([^;]*);([^;]*);([^;]*);(\d+)$/)
    if (sectionMatch) {
      return new UnsupportedBlock({
        rawHtml: `<!--${comment}-->`,
        source: "confluence"
      })
    }

    // cf:section-end:index
    if (comment.startsWith("cf:section-end:")) {
      return new UnsupportedBlock({
        rawHtml: `<!--${comment}-->`,
        source: "confluence"
      })
    }

    // cf:cell:sectionIndex;cellIndex
    const cellMatch = comment.match(/^cf:cell:(\d+);(\d+)$/)
    if (cellMatch) {
      return new UnsupportedBlock({
        rawHtml: `<!--${comment}-->`,
        source: "confluence"
      })
    }

    return null
  })

/**
 * Convert hast Element to BlockNode or MacroNode.
 */
const hastElementToNode = (element: HastElement): Effect.Effect<DocumentNode | null, ParseError> =>
  Effect.gen(function*() {
    const tagName = element.tagName.toLowerCase()

    // Heading
    if (/^h[1-6]$/.test(tagName)) {
      const levelStr = tagName[1]
      if (!levelStr) return null
      const level = parseInt(levelStr) as 1 | 2 | 3 | 4 | 5 | 6
      const children = yield* hastChildrenToInline(element.children)
      return new Heading({ level, children })
    }

    // Paragraph (with optional alignment and indent)
    if (tagName === "p") {
      const children = yield* hastChildrenToInline(element.children)
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
        (c): c is HastElement => c.type === "element" && (c as HastElement).tagName === "code"
      )
      const code = codeEl ? getTextContent(codeEl) : getTextContent(element)
      const language = (element.properties?.["dataLanguage"] as string) || undefined
      return new CodeBlock({ code, language })
    }

    // Thematic break
    if (tagName === "hr") {
      return new ThematicBreak({})
    }

    // Image (supports both URL and Confluence attachments from preprocessed data)
    if (tagName === "img") {
      const src = element.properties?.src as string | undefined
      const dataAttachment = element.properties?.["dataAttachment"] as string | undefined
      const dataAlign = element.properties?.["dataAlign"] as string | undefined
      const dataWidth = element.properties?.["dataWidth"] as string | undefined
      const alt = (element.properties?.alt as string) || undefined

      // Confluence attachment (preprocessed)
      if (dataAttachment) {
        return new Image({
          attachment: { filename: dataAttachment },
          alt,
          ...(dataAlign ? { align: dataAlign } : {}),
          ...(dataWidth ? { width: parseInt(dataWidth) } : {})
        })
      }

      // URL-based image
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

    // Task list (from preprocessed data)
    if (tagName === "ul" && element.properties?.["dataMacro"] === "task-list") {
      return yield* parseTaskList(element)
    }

    // Lists
    if (tagName === "ul" || tagName === "ol") {
      return yield* parseList(element, tagName === "ol")
    }

    // Block quote
    if (tagName === "blockquote") {
      const children = yield* hastChildrenToSimpleBlocks(element.children)
      return { _tag: "BlockQuote" as const, version: 1, children }
    }

    // Macro divs
    if (tagName === "div" && element.properties?.["dataMacro"]) {
      const macro = element.properties["dataMacro"] as string
      if ((PanelTypes as ReadonlyArray<string>).includes(macro)) {
        const children = yield* hastChildrenToSimpleBlocks(element.children)
        return {
          _tag: "InfoPanel" as const,
          version: 1,
          panelType: macro as (typeof PanelTypes)[number],
          title: (element.properties["dataTitle"] as string) || undefined,
          children
        } satisfies InfoPanel
      }
    }

    // Expand/details
    if (tagName === "details") {
      const summary = element.children.find(
        (c): c is HastElement => c.type === "element" && (c as HastElement).tagName === "summary"
      )
      const title = summary ? getTextContent(summary) : undefined
      const contentChildren = element.children.filter(
        (c) => !(c.type === "element" && (c as HastElement).tagName === "summary")
      )
      const children = yield* hastChildrenToSimpleBlocks(contentChildren)
      return {
        _tag: "ExpandMacro" as const,
        version: 1,
        title,
        children
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

    // Unsupported macro
    if (element.properties?.["dataUnsupportedMacro"]) {
      return new UnsupportedBlock({
        rawHtml: hastToHtml(element),
        source: "confluence"
      })
    }

    // Generic div - recurse into children
    if (tagName === "div" || tagName === "section" || tagName === "article") {
      const children: Array<DocumentNode> = []
      for (const child of element.children) {
        if (child.type === "element") {
          const node = yield* hastElementToNode(child as HastElement)
          if (node !== null) children.push(node)
        }
      }
      if (children.length >= 1) {
        const first = children[0]
        return first !== undefined ? first : null
      }
      return null
    }

    // Ignore common layout elements
    if (["br", "html", "head", "body"].includes(tagName)) {
      return null
    }

    // Inline elements at block level - wrap in paragraph
    if (["a", "strong", "em", "b", "i", "u", "code", "del", "sub", "sup", "span"].includes(tagName)) {
      const inlineNode = yield* hastElementToInline(element)
      if (inlineNode) {
        return new Paragraph({ children: [inlineNode] })
      }
      return null
    }

    // Unknown block element
    return new UnsupportedBlock({
      rawHtml: hastToHtml(element),
      source: "confluence"
    })
  })

/**
 * Convert hast children to inline nodes.
 */
const hastChildrenToInline = (
  children: Array<HastNode>
): Effect.Effect<Array<InlineNode>, ParseError> =>
  Effect.gen(function*() {
    const nodes: Array<InlineNode> = []
    for (const child of children) {
      if (child.type === "text") {
        const textNode = child as HastText
        if (textNode.value.trim() || nodes.length > 0) {
          nodes.push(new Text({ value: textNode.value }))
        }
      } else if (child.type === "element") {
        const node = yield* hastElementToInline(child as HastElement)
        if (node !== null) nodes.push(node)
      }
    }
    return nodes
  })

/**
 * Convert hast Element to InlineNode.
 */
const hastElementToInline = (element: HastElement): Effect.Effect<InlineNode | null, ParseError> =>
  Effect.gen(function*() {
    const tagName = element.tagName.toLowerCase()

    // Strong/bold
    if (tagName === "strong" || tagName === "b") {
      const children = yield* hastChildrenToBaseInline(element.children)
      return new Strong({ children })
    }

    // Emphasis/italic
    if (tagName === "em" || tagName === "i") {
      const children = yield* hastChildrenToBaseInline(element.children)
      return new Emphasis({ children })
    }

    // Underline
    if (tagName === "u") {
      const children = yield* hastChildrenToBaseInline(element.children)
      return new Underline({ children })
    }

    // Strikethrough
    if (tagName === "del" || tagName === "s") {
      const children = yield* hastChildrenToBaseInline(element.children)
      return new Strikethrough({ children })
    }

    // Subscript
    if (tagName === "sub") {
      const children = yield* hastChildrenToBaseInline(element.children)
      return new Subscript({ children })
    }

    // Superscript
    if (tagName === "sup") {
      const children = yield* hastChildrenToBaseInline(element.children)
      return new Superscript({ children })
    }

    // Inline code
    if (tagName === "code") {
      return new InlineCode({ value: getTextContent(element) })
    }

    // Smart link (Jira, Confluence search, etc.) - preserve datasource for roundtrip
    if (tagName === "a" && element.properties?.["dataDatasource"]) {
      const href = element.properties?.href as string | undefined
      const appearance = (element.properties?.["dataCardAppearance"] as string) || "inline"
      const datasource = element.properties["dataDatasource"] as string
      return new UnsupportedInline({
        raw: `<!--cf:smartlink:${encodeURIComponent(href ?? "")};${encodeURIComponent(appearance)};${
          encodeURIComponent(datasource)
        }-->`,
        source: "confluence"
      })
    }

    // Link
    if (tagName === "a") {
      const href = element.properties?.href as string | undefined
      if (!href) return null
      const children = yield* hastChildrenToBaseInline(element.children)
      return new Link({
        href,
        title: (element.properties?.title as string) || undefined,
        children
      })
    }

    // Line break
    if (tagName === "br") {
      return new LineBreak({})
    }

    // Date/time (rehype converts datetime attr to camelCase dateTime)
    if (tagName === "time") {
      const datetime = (element.properties?.dateTime as string) || ""
      return new DateTime({ datetime })
    }

    // Emoticon (preprocessed from ac:emoticon)
    if (tagName === "span" && element.properties?.["dataEmoji"]) {
      const shortname = (element.properties["dataEmoji"] as string) || ""
      const emojiId = (element.properties["dataEmojiId"] as string) || ""
      const fallback = getTextContent(element)
      return new Emoticon({ shortname, emojiId, fallback })
    }

    // User mention (preprocessed from ac:link > ri:user)
    if (tagName === "span" && element.properties?.["dataUserMention"]) {
      const accountId = (element.properties["dataUserMention"] as string) || ""
      return new UserMention({ accountId })
    }

    // Confluence link with link-body (preprocessed from ac:link > ac:link-body)
    if (tagName === "span" && element.properties?.["dataConfluenceLink"] !== undefined) {
      const linkText = getTextContent(element)
      return new UnsupportedInline({
        raw: `<!--cf:link:${encodeURIComponent(linkText)}-->`,
        source: "confluence"
      })
    }

    // Status macro (inline) - use comment encoding for roundtrip
    if (tagName === "span" && element.properties?.["dataMacro"] === "status") {
      const color = (element.properties["dataColor"] as string) || ""
      const title = getTextContent(element)
      return new UnsupportedInline({
        raw: `<!--cf:status:${encodeURIComponent(title)};${encodeURIComponent(color)}-->`,
        source: "confluence"
      })
    }

    // TOC macro in inline context (e.g., inside table cell) - use comment encoding
    // Use ; as separator (not | which breaks markdown tables)
    if (tagName === "nav" && element.properties?.["dataMacro"] === "toc") {
      const minStr = element.properties["dataMin"] as string | undefined
      const maxStr = element.properties["dataMax"] as string | undefined
      return new UnsupportedInline({
        raw: `<!--cf:toc:${minStr ?? ""};${maxStr ?? ""}-->`,
        source: "confluence"
      })
    }

    // Colored text (span with color style)
    if (tagName === "span") {
      const style = element.properties?.style as string | undefined
      if (style) {
        const colorMatch = style.match(/(?:^|;)\s*color:\s*([^;]+)/)
        const bgMatch = style.match(/(?:^|;)\s*background-color:\s*([^;]+)/)

        if (colorMatch?.[1]) {
          const children = yield* hastChildrenToBaseInline(element.children)
          return new ColoredText({ color: colorMatch[1].trim(), children })
        }

        if (bgMatch?.[1]) {
          const children = yield* hastChildrenToBaseInline(element.children)
          return new Highlight({ backgroundColor: bgMatch[1].trim(), children })
        }
      }

      // Nested inline elements - extract content
      const children = yield* hastChildrenToInline(element.children)
      if (children.length === 1) {
        const first = children[0]
        return first !== undefined ? first : null
      }
      return null
    }

    // Images can be inline too
    if (tagName === "img") {
      return new UnsupportedInline({
        raw: hastToHtml(element),
        source: "confluence"
      })
    }

    // Unknown inline element
    return new UnsupportedInline({
      raw: hastToHtml(element),
      source: "confluence"
    })
  })

/**
 * Convert hast children to base inline nodes (for Strong/Emphasis/Link children).
 */
const hastChildrenToBaseInline = (
  children: Array<HastNode>
): Effect.Effect<Array<Text | InlineCode | LineBreak | UnsupportedInline>, ParseError> =>
  Effect.gen(function*() {
    const nodes: Array<Text | InlineCode | LineBreak | UnsupportedInline> = []
    for (const child of children) {
      if (child.type === "text") {
        const textNode = child as HastText
        nodes.push(new Text({ value: textNode.value }))
      } else if (child.type === "element") {
        const el = child as HastElement
        const tagName = el.tagName.toLowerCase()
        if (tagName === "code") {
          nodes.push(new InlineCode({ value: getTextContent(el) }))
        } else if (tagName === "br") {
          nodes.push(new LineBreak({}))
        } else {
          nodes.push(new UnsupportedInline({ raw: hastToHtml(el), source: "confluence" }))
        }
      }
    }
    return nodes
  })

/**
 * Convert hast children to simple block nodes (non-recursive).
 */
const hastChildrenToSimpleBlocks = (
  children: Array<HastNode>
): Effect.Effect<
  Array<Heading | Paragraph | CodeBlock | ThematicBreak | Image | Table | UnsupportedBlock>,
  ParseError
> =>
  Effect.gen(function*() {
    const blocks: Array<Heading | Paragraph | CodeBlock | ThematicBreak | Image | Table | UnsupportedBlock> = []
    for (const child of children) {
      if (child.type === "element") {
        const el = child as HastElement
        const tagName = el.tagName.toLowerCase()

        if (/^h[1-6]$/.test(tagName)) {
          const levelStr = tagName[1]
          if (levelStr) {
            const level = parseInt(levelStr) as 1 | 2 | 3 | 4 | 5 | 6
            const inlineChildren = yield* hastChildrenToInline(el.children)
            blocks.push(new Heading({ level, children: inlineChildren }))
          }
        } else if (tagName === "p") {
          const inlineChildren = yield* hastChildrenToInline(el.children)
          blocks.push(new Paragraph({ children: inlineChildren }))
        } else if (tagName === "pre") {
          const codeEl = el.children.find(
            (c): c is HastElement => c.type === "element" && (c as HastElement).tagName === "code"
          )
          const code = codeEl ? getTextContent(codeEl) : getTextContent(el)
          blocks.push(new CodeBlock({ code }))
        } else if (tagName === "hr") {
          blocks.push(new ThematicBreak({}))
        } else if (tagName === "img") {
          const src = el.properties?.src as string | undefined
          if (src) blocks.push(new Image({ src }))
        } else if (tagName === "table") {
          blocks.push(yield* parseTable(el))
        } else {
          blocks.push(new UnsupportedBlock({ rawHtml: hastToHtml(el), source: "confluence" }))
        }
      }
    }
    return blocks
  })

/**
 * Parse table element.
 */
const parseTable = (element: HastElement): Effect.Effect<Table, ParseError> =>
  Effect.gen(function*() {
    let header: TableRow | undefined
    const rows: Array<TableRow> = []

    for (const child of element.children) {
      if (child.type !== "element") continue
      const el = child as HastElement

      if (el.tagName === "thead") {
        const tr = el.children.find(
          (c): c is HastElement => c.type === "element" && (c as HastElement).tagName === "tr"
        )
        if (tr) {
          header = yield* parseTableRow(tr, true)
        }
      } else if (el.tagName === "tbody") {
        for (const row of el.children) {
          if (row.type === "element" && (row as HastElement).tagName === "tr") {
            const tr = row as HastElement
            // Check if this row has all <th> cells - treat as header if no header yet
            const allTh = tr.children
              .filter((c) => c.type === "element")
              .every((c) => (c as HastElement).tagName === "th")
            if (allTh && !header && rows.length === 0) {
              header = yield* parseTableRow(tr, true)
            } else {
              rows.push(yield* parseTableRow(tr, false))
            }
          }
        }
      } else if (el.tagName === "tr") {
        rows.push(yield* parseTableRow(el, false))
      }
    }

    return new Table({ header, rows })
  })

/**
 * Parse table row.
 */
const parseTableRow = (element: HastElement, isHeader: boolean): Effect.Effect<TableRow, ParseError> =>
  Effect.gen(function*() {
    const cells: Array<TableCell> = []
    for (const child of element.children) {
      if (child.type === "element") {
        const el = child as HastElement
        if (el.tagName === "td" || el.tagName === "th") {
          const cellIsHeader = isHeader || el.tagName === "th"
          // Unwrap single <p> elements inside cells
          const children = yield* parseCellContent(el.children)
          cells.push(new TableCell({ isHeader: cellIsHeader, children }))
        }
      }
    }
    return new TableRow({ cells })
  })

/**
 * Parse cell content, unwrapping single <p> elements.
 */
const parseCellContent = (children: Array<HastNode>): Effect.Effect<Array<InlineNode>, ParseError> =>
  Effect.gen(function*() {
    // Find actual element children (skip whitespace text)
    const elementChildren = children.filter((c) => {
      if (c.type === "element") return true
      if (c.type === "text" && (c as HastText).value.trim()) return true
      return false
    })

    // If single <p> element, unwrap it
    if (elementChildren.length === 1) {
      const first = elementChildren[0]
      if (first && first.type === "element" && (first as HastElement).tagName === "p") {
        return yield* hastChildrenToInline((first as HastElement).children)
      }
    }

    // Otherwise parse normally
    return yield* hastChildrenToInline(children)
  })

// Type for simple blocks used in lists
type SimpleBlock = Heading | Paragraph | CodeBlock | ThematicBreak | Image | Table | UnsupportedBlock

/**
 * Parse task list element (preprocessed from ac:task-list).
 */
const parseTaskList = (
  element: HastElement
): Effect.Effect<TaskList, ParseError> =>
  Effect.gen(function*() {
    const items: Array<TaskItem> = []

    for (const child of element.children) {
      if (child.type === "element" && (child as HastElement).tagName === "li") {
        const li = child as HastElement
        const id = (li.properties?.["dataTaskId"] as string) || ""
        const uuid = (li.properties?.["dataTaskUuid"] as string) || ""
        const status = (li.properties?.["dataTaskStatus"] as string) === "complete"
          ? "complete" as const
          : "incomplete" as const
        const body = yield* hastChildrenToInline(li.children)

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
): Effect.Effect<
  {
    _tag: "List"
    version: number
    ordered: boolean
    start?: number
    children: Array<{ _tag: "ListItem"; checked?: boolean; children: Array<SimpleBlock> }>
  },
  ParseError
> =>
  Effect.gen(function*() {
    const items: Array<{ _tag: "ListItem"; checked?: boolean; children: Array<SimpleBlock> }> = []
    const startProp = element.properties?.start
    const start = ordered && startProp ? parseInt(String(startProp)) : undefined

    for (const child of element.children) {
      if (child.type === "element" && (child as HastElement).tagName === "li") {
        const li = child as HastElement
        const children = yield* parseListItemContent(li.children)
        // Check for task list items
        const checkbox = li.children.find(
          (c): c is HastElement =>
            c.type === "element" &&
            (c as HastElement).tagName === "input" &&
            (c as HastElement).properties?.type === "checkbox"
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

/**
 * Parse list item content, handling nested lists and unwrapping single <p>.
 * Also handles direct text/inline content without wrapper elements.
 */
const parseListItemContent = (
  children: Array<HastNode>
): Effect.Effect<Array<SimpleBlock>, ParseError> =>
  Effect.gen(function*() {
    const blocks: Array<SimpleBlock> = []

    // Check if there's any direct text/inline content (not wrapped in <p>)
    const hasDirectInlineContent = children.some((child) => {
      if (child.type === "text") {
        return (child as HastText).value.trim() !== ""
      }
      if (child.type === "element") {
        const tagName = (child as HastElement).tagName.toLowerCase()
        // Inline elements that should be wrapped in a paragraph
        return ["a", "strong", "em", "b", "i", "u", "code", "span", "del", "sub", "sup"].includes(tagName)
      }
      return false
    })

    // If there's direct inline content, wrap it all in a paragraph
    if (hasDirectInlineContent) {
      const inlineChildren = yield* hastChildrenToInline(children)
      if (inlineChildren.length > 0) {
        blocks.push(new Paragraph({ children: inlineChildren }))
      }
      // Also check for nested lists after the inline content
      for (const child of children) {
        if (child.type === "element") {
          const el = child as HastElement
          const tagName = el.tagName.toLowerCase()
          if (tagName === "ul" || tagName === "ol") {
            blocks.push(new UnsupportedBlock({ rawHtml: hastToHtml(el), source: "confluence" }))
          }
        }
      }
      return blocks
    }

    for (const child of children) {
      if (child.type !== "element") continue
      const el = child as HastElement
      const tagName = el.tagName.toLowerCase()

      // Single <p> inside list item - extract inline content as paragraph
      if (tagName === "p") {
        const inlineChildren = yield* hastChildrenToInline(el.children)
        blocks.push(new Paragraph({ children: inlineChildren }))
      } // Nested lists - convert to paragraph with raw HTML for now (will be handled later)
      else if (tagName === "ul" || tagName === "ol") {
        // For nested lists, preserve as unsupported for now
        blocks.push(new UnsupportedBlock({ rawHtml: hastToHtml(el), source: "confluence" }))
      } // Other block elements
      else if (tagName === "pre") {
        const codeEl = el.children.find(
          (c): c is HastElement => c.type === "element" && (c as HastElement).tagName === "code"
        )
        const code = codeEl ? getTextContent(codeEl) : getTextContent(el)
        blocks.push(new CodeBlock({ code }))
      } else if (tagName === "hr") {
        blocks.push(new ThematicBreak({}))
      } else if (tagName === "img") {
        const src = el.properties?.src as string | undefined
        if (src) blocks.push(new Image({ src }))
      } else if (tagName === "table") {
        blocks.push(yield* parseTable(el))
      } else if (/^h[1-6]$/.test(tagName)) {
        const levelStr = tagName[1]
        if (levelStr) {
          const level = parseInt(levelStr) as 1 | 2 | 3 | 4 | 5 | 6
          const inlineChildren = yield* hastChildrenToInline(el.children)
          blocks.push(new Heading({ level, children: inlineChildren }))
        }
      }
    }

    return blocks
  })

/**
 * Get text content from hast node.
 */
const getTextContent = (element: HastElement): string => {
  let text = ""
  for (const child of element.children) {
    if (child.type === "text") {
      text += (child as HastText).value
    } else if (child.type === "element") {
      text += getTextContent(child as HastElement)
    }
  }
  return text
}

/**
 * Convert hast element back to HTML string (for unsupported elements).
 */
const hastToHtml = (element: HastElement): string => {
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
      if (c.type === "text") return (c as HastText).value
      if (c.type === "element") return hastToHtml(c as HastElement)
      return ""
    })
    .join("")
  return `${openTag}${content}${closeTag}`
}
