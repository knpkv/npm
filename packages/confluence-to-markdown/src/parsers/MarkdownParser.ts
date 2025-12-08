/**
 * Parser for Markdown to AST.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
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
import { type InfoPanel, PanelTypes, type TocMacro } from "../ast/MacroNode.js"
import { ParseError } from "../SchemaConverterError.js"

// Mdast types (inline to avoid dependency)
interface MdastText {
  type: "text"
  value: string
}

interface MdastInlineCode {
  type: "inlineCode"
  value: string
}

interface MdastStrong {
  type: "strong"
  children: Array<MdastNode>
}

interface MdastEmphasis {
  type: "emphasis"
  children: Array<MdastNode>
}

interface MdastDelete {
  type: "delete"
  children: Array<MdastNode>
}

interface MdastLink {
  type: "link"
  url: string
  title?: string | null
  children: Array<MdastNode>
}

interface MdastBreak {
  type: "break"
}

interface MdastHeading {
  type: "heading"
  depth: 1 | 2 | 3 | 4 | 5 | 6
  children: Array<MdastNode>
}

interface MdastParagraph {
  type: "paragraph"
  children: Array<MdastNode>
}

interface MdastCode {
  type: "code"
  lang?: string | null
  meta?: string | null
  value: string
}

interface MdastThematicBreak {
  type: "thematicBreak"
}

interface MdastImage {
  type: "image"
  url: string
  alt?: string | null
  title?: string | null
}

interface MdastBlockquote {
  type: "blockquote"
  children: Array<MdastNode>
}

interface MdastList {
  type: "list"
  ordered?: boolean | null
  start?: number | null
  spread?: boolean | null
  children: Array<MdastListItem>
}

interface MdastListItem {
  type: "listItem"
  checked?: boolean | null
  spread?: boolean | null
  children: Array<MdastNode>
}

interface MdastTable {
  type: "table"
  align?: Array<"left" | "right" | "center" | null> | null
  children: Array<MdastTableRow>
}

interface MdastTableRow {
  type: "tableRow"
  children: Array<MdastTableCell>
}

interface MdastTableCell {
  type: "tableCell"
  children: Array<MdastNode>
}

interface MdastRoot {
  type: "root"
  children: Array<MdastNode>
}

interface MdastHtml {
  type: "html"
  value: string
}

type MdastNode =
  | MdastText
  | MdastInlineCode
  | MdastStrong
  | MdastEmphasis
  | MdastDelete
  | MdastLink
  | MdastBreak
  | MdastHeading
  | MdastParagraph
  | MdastCode
  | MdastThematicBreak
  | MdastImage
  | MdastBlockquote
  | MdastList
  | MdastListItem
  | MdastTable
  | MdastTableRow
  | MdastTableCell
  | MdastRoot
  | MdastHtml
  | { type: string }

/**
 * Parse Markdown to Document AST.
 *
 * @example
 * ```typescript
 * import { parseMarkdown } from "@knpkv/confluence-to-markdown/parsers/MarkdownParser"
 * import { Effect } from "effect"
 *
 * Effect.gen(function* () {
 *   const doc = yield* parseMarkdown("# Title\n\nContent")
 *   console.log(doc.children.length) // 2
 * })
 * ```
 *
 * @category Parsers
 */
export const parseMarkdown = (markdown: string): Effect.Effect<Document, ParseError> =>
  Effect.gen(function*() {
    // Check for embedded rawConfluence comment (for 1-to-1 roundtrip)
    const rawMatch = markdown.match(/<!--cf:raw:([A-Za-z0-9+/=]+)-->/)
    let rawConfluence: string | undefined
    let cleanMarkdown = markdown

    if (rawMatch) {
      // Extract and decode the raw Confluence HTML
      const encoded = rawMatch[1] ?? ""
      rawConfluence = Buffer.from(encoded, "base64").toString("utf-8")
      // Remove the raw comment from markdown for parsing
      cleanMarkdown = markdown.replace(/\n*<!--cf:raw:[A-Za-z0-9+/=]+-->\s*$/, "")
    }

    // Preprocess container syntax (:::type ... :::) to HTML comments
    cleanMarkdown = preprocessContainers(cleanMarkdown)

    // Parse Markdown to mdast
    const mdast = yield* Effect.try({
      try: () =>
        unified()
          .use(remarkParse)
          .use(remarkGfm)
          .parse(cleanMarkdown) as MdastRoot,
      catch: (error) =>
        new ParseError({
          source: "markdown",
          message: `Markdown parse error: ${error instanceof Error ? error.message : String(error)}`,
          rawContent: markdown.slice(0, 200)
        })
    })

    // Convert mdast to AST
    const children = yield* mdastToDocumentNodes(mdast)
    return makeDocument(children, rawConfluence)
  })

/**
 * Preprocess :::type container syntax to HTML comments.
 * Converts :::info\ncontent\n::: to <!--cf:panel:info::encodedContent-->
 * Optionally with title: :::info Title\ncontent\n::: to <!--cf:panel:info:Title:encodedContent-->
 */
const preprocessContainers = (markdown: string): string => {
  // Match :::type with optional same-line title, then content, then :::
  // Title must be on same line as opening :::type
  const containerRegex = /^:::(\w+)(?: ([^\n]+))?\n([\s\S]*?)\n:::$/gm
  return markdown.replace(containerRegex, (_, type, title, content) => {
    const panelType = type.toLowerCase()
    const encodedContent = encodeURIComponent(content.trim())
    const encodedTitle = title ? encodeURIComponent(title.trim()) : ""
    return `<!--cf:panel:${panelType}:${encodedTitle}:${encodedContent}-->`
  })
}

/**
 * Convert mdast Root to document nodes.
 */
const mdastToDocumentNodes = (root: MdastRoot): Effect.Effect<Array<DocumentNode>, ParseError> =>
  Effect.gen(function*() {
    const nodes: Array<DocumentNode> = []
    for (const child of root.children) {
      const node = yield* mdastNodeToBlock(child)
      if (node !== null) nodes.push(node)
    }
    return nodes
  })

/**
 * Convert mdast node to BlockNode or MacroNode.
 */
const mdastNodeToBlock = (node: MdastNode): Effect.Effect<DocumentNode | null, ParseError> =>
  Effect.gen(function*() {
    switch (node.type) {
      case "heading": {
        const heading = node as MdastHeading
        const children = yield* mdastChildrenToInline(heading.children)
        return new Heading({ level: heading.depth, children })
      }

      case "paragraph": {
        const para = node as MdastParagraph
        // Check if paragraph is just [[toc]] - convert to TocMacro
        if (para.children.length === 1 && para.children[0]?.type === "text") {
          const textContent = (para.children[0] as MdastText).value.trim()
          if (textContent === "[[toc]]") {
            return { _tag: "TocMacro" as const, version: 1 } satisfies TocMacro
          }
        }
        const children = yield* mdastChildrenToInline(para.children)
        return new Paragraph({ children })
      }

      case "code": {
        const code = node as MdastCode
        return new CodeBlock({
          code: code.value,
          language: code.lang || undefined
        })
      }

      case "thematicBreak": {
        return new ThematicBreak({})
      }

      case "image": {
        const img = node as MdastImage
        return new Image({
          src: img.url,
          alt: img.alt || undefined,
          title: img.title || undefined
        })
      }

      case "blockquote": {
        const bq = node as MdastBlockquote
        const children = yield* mdastChildrenToSimpleBlocks(bq.children)
        return { _tag: "BlockQuote" as const, version: 1, children }
      }

      case "list": {
        const list = node as MdastList
        return yield* parseList(list)
      }

      case "table": {
        const table = node as MdastTable
        return yield* parseTable(table)
      }

      case "html": {
        const html = node as MdastHtml
        // Check for comment-encoded task list
        const taskListParsed = yield* parseTaskListComment(html.value)
        if (taskListParsed) return taskListParsed
        // Check for comment-encoded image
        const imageParsed = yield* parseImageComment(html.value)
        if (imageParsed) return imageParsed
        // Check for comment-encoded expand macro
        const expandParsed = yield* parseExpandMacroComment(html.value)
        if (expandParsed) return expandParsed
        // Check for comment-encoded TOC macro
        const tocParsed = yield* parseTocComment(html.value)
        if (tocParsed) return tocParsed
        // Check for comment-encoded status macro (wrap in paragraph)
        const statusParsed = yield* parseStatusComment(html.value)
        if (statusParsed) return statusParsed
        // Check for comment-encoded smart link (wrap in paragraph)
        const smartLinkParsed = yield* parseSmartLinkComment(html.value)
        if (smartLinkParsed) return smartLinkParsed
        // Check for comment-encoded decision list
        const decisionParsed = yield* parseDecisionComment(html.value)
        if (decisionParsed) return decisionParsed
        // Check for comment-encoded layout
        const layoutParsed = yield* parseLayoutComment(html.value)
        if (layoutParsed) return layoutParsed
        // Check for comment-encoded panel (:::type container)
        const panelParsed = yield* parsePanelComment(html.value)
        if (panelParsed) return panelParsed
        // Check for comment-encoded inline elements that should become paragraphs
        const inlineParsed = yield* parseBlockLevelInlineComment(html.value)
        if (inlineParsed) return inlineParsed
        return new UnsupportedBlock({
          rawMarkdown: html.value,
          source: "markdown"
        })
      }

      default:
        return null
    }
  })

/**
 * Convert mdast children to inline nodes.
 * Handles paired HTML tags like <span style="color:...">...</span> by looking ahead.
 */
const mdastChildrenToInline = (children: Array<MdastNode>): Effect.Effect<Array<InlineNode>, ParseError> =>
  Effect.gen(function*() {
    const nodes: Array<InlineNode> = []
    let i = 0

    while (i < children.length) {
      const child = children[i]
      if (!child) {
        i++
        continue
      }

      // Handle text nodes specially - they can contain embedded HTML comments
      if (child.type === "text") {
        const text = child as MdastText
        const parsed = yield* parseTextWithEmbeddedHtml(text.value)
        for (const p of parsed) nodes.push(p)
        i++
        continue
      }

      // Check for paired HTML tags (span with color/background)
      if (child.type === "html") {
        const html = child as MdastHtml
        const pairedResult = yield* tryParsePairedHtmlTag(html.value, children, i)
        if (pairedResult) {
          nodes.push(pairedResult.node)
          i = pairedResult.nextIndex
          continue
        }
      }

      // Regular node processing
      const node = yield* mdastNodeToInline(child)
      if (node !== null) nodes.push(node)
      i++
    }
    return nodes
  })

/**
 * Try to parse paired HTML tags like <span style="color:...">content</span>.
 * Returns the parsed node and next index if successful, null otherwise.
 */
const tryParsePairedHtmlTag = (
  openingTag: string,
  children: Array<MdastNode>,
  startIndex: number
): Effect.Effect<{ node: InlineNode; nextIndex: number } | null, ParseError> =>
  Effect.gen(function*() {
    // Check for color span: <span style="color: ...;">
    const colorMatch = openingTag.match(/^<span\s+style="color:\s*([^;]+);">$/)
    if (colorMatch) {
      const result = yield* collectUntilClosingTag(children, startIndex + 1, "</span>")
      if (result) {
        const innerNodes = yield* mdastChildrenToInline(result.innerChildren)
        const baseNodes = inlineNodesToBase(innerNodes)
        return {
          node: new ColoredText({ color: colorMatch[1] ?? "", children: baseNodes }),
          nextIndex: result.nextIndex
        }
      }
    }

    // Check for highlight span: <span style="background-color: ...;">
    const bgMatch = openingTag.match(/^<span\s+style="background-color:\s*([^;]+);">$/)
    if (bgMatch) {
      const result = yield* collectUntilClosingTag(children, startIndex + 1, "</span>")
      if (result) {
        const innerNodes = yield* mdastChildrenToInline(result.innerChildren)
        const baseNodes = inlineNodesToBase(innerNodes)
        return {
          node: new Highlight({ backgroundColor: bgMatch[1] ?? "", children: baseNodes }),
          nextIndex: result.nextIndex
        }
      }
    }

    // Check for underline: <u>
    if (openingTag === "<u>") {
      const result = yield* collectUntilClosingTag(children, startIndex + 1, "</u>")
      if (result) {
        const innerNodes = yield* mdastChildrenToInline(result.innerChildren)
        const baseNodes = inlineNodesToBase(innerNodes)
        return {
          node: new Underline({ children: baseNodes }),
          nextIndex: result.nextIndex
        }
      }
    }

    // Check for subscript: <sub>
    if (openingTag === "<sub>") {
      const result = yield* collectUntilClosingTag(children, startIndex + 1, "</sub>")
      if (result) {
        const innerNodes = yield* mdastChildrenToInline(result.innerChildren)
        const baseNodes = inlineNodesToBase(innerNodes)
        return {
          node: new Subscript({ children: baseNodes }),
          nextIndex: result.nextIndex
        }
      }
    }

    // Check for superscript: <sup>
    if (openingTag === "<sup>") {
      const result = yield* collectUntilClosingTag(children, startIndex + 1, "</sup>")
      if (result) {
        const innerNodes = yield* mdastChildrenToInline(result.innerChildren)
        const baseNodes = inlineNodesToBase(innerNodes)
        return {
          node: new Superscript({ children: baseNodes }),
          nextIndex: result.nextIndex
        }
      }
    }

    return null
  })

/**
 * Collect mdast nodes until a closing HTML tag is found.
 * Returns the inner children and the index after the closing tag.
 */
const collectUntilClosingTag = (
  children: Array<MdastNode>,
  startIndex: number,
  closingTag: string
): Effect.Effect<{ innerChildren: Array<MdastNode>; nextIndex: number } | null, ParseError> =>
  Effect.gen(function*() {
    const innerChildren: Array<MdastNode> = []

    for (let i = startIndex; i < children.length; i++) {
      const child = children[i]
      if (!child) continue

      if (child.type === "html") {
        const html = child as MdastHtml
        if (html.value === closingTag) {
          return { innerChildren, nextIndex: i + 1 }
        }
      }

      innerChildren.push(child)
    }

    // No closing tag found
    return null
  })

/**
 * Convert InlineNode array to base inline nodes for nested formatting.
 */
const inlineNodesToBase = (
  nodes: Array<InlineNode>
): Array<Text | InlineCode | LineBreak | UnsupportedInline> => {
  const result: Array<Text | InlineCode | LineBreak | UnsupportedInline> = []
  for (const node of nodes) {
    switch (node._tag) {
      case "Text":
      case "InlineCode":
      case "LineBreak":
      case "UnsupportedInline":
        result.push(node as Text | InlineCode | LineBreak | UnsupportedInline)
        break
      default:
        // For complex nodes, serialize to raw string
        result.push(new UnsupportedInline({ raw: JSON.stringify(node), source: "markdown" }))
    }
  }
  return result
}

/**
 * Convert mdast node to InlineNode.
 */
const mdastNodeToInline = (node: MdastNode): Effect.Effect<InlineNode | null, ParseError> =>
  Effect.gen(function*() {
    switch (node.type) {
      case "text": {
        const text = node as MdastText
        return new Text({ value: text.value })
      }

      case "strong": {
        const strong = node as MdastStrong
        const children = yield* mdastChildrenToBaseInline(strong.children)
        return new Strong({ children })
      }

      case "emphasis": {
        const em = node as MdastEmphasis
        const children = yield* mdastChildrenToBaseInline(em.children)
        return new Emphasis({ children })
      }

      case "delete": {
        const del = node as MdastDelete
        const children = yield* mdastChildrenToBaseInline(del.children)
        return new Strikethrough({ children })
      }

      case "inlineCode": {
        const code = node as MdastInlineCode
        return new InlineCode({ value: code.value })
      }

      case "link": {
        const link = node as MdastLink
        const children = yield* mdastChildrenToBaseInline(link.children)
        return new Link({
          href: link.url,
          title: link.title || undefined,
          children
        })
      }

      case "break": {
        return new LineBreak({})
      }

      case "image": {
        const img = node as MdastImage
        return new UnsupportedInline({
          raw: `![${img.alt || ""}](${img.url})`,
          source: "markdown"
        })
      }

      case "html": {
        const html = node as MdastHtml
        const parsed = yield* parseInlineHtml(html.value)
        if (parsed) return parsed
        return new UnsupportedInline({
          raw: html.value,
          source: "markdown"
        })
      }

      default:
        return null
    }
  })

/**
 * Parse inline HTML that was preserved for roundtrip.
 */
const parseInlineHtml = (html: string): Effect.Effect<InlineNode | null, ParseError> =>
  Effect.gen(function*() {
    // Comment-encoded Emoticon: <!--cf:emoticon:shortname|emojiId|fallback-->
    // Use non-greedy match since values can contain special chars
    const emoticonCommentMatch = html.match(/<!--cf:emoticon:([^|]*)\|([^|]*)\|(.+?)-->/)
    if (emoticonCommentMatch) {
      return new Emoticon({
        shortname: decodeURIComponent(emoticonCommentMatch[1] ?? ""),
        emojiId: decodeURIComponent(emoticonCommentMatch[2] ?? ""),
        fallback: decodeURIComponent(emoticonCommentMatch[3] ?? "")
      })
    }

    // Comment-encoded User mention: <!--cf:user:accountId-->
    // Account IDs can contain dashes, colons, etc. Match everything until -->
    const userCommentMatch = html.match(/<!--cf:user:(.+?)-->/)
    if (userCommentMatch) {
      return new UserMention({ accountId: userCommentMatch[1] ?? "" })
    }

    // Comment-encoded DateTime: <!--cf:date:datetime-->
    // Use non-greedy match since dates can contain dashes, allow empty datetime
    const dateCommentMatch = html.match(/<!--cf:date:(.*?)-->/)
    if (dateCommentMatch) {
      return new DateTime({ datetime: dateCommentMatch[1] ?? "" })
    }

    // Colored text
    const colorMatch = html.match(/<span style="color:\s*([^;]+);">([^<]*)<\/span>/)
    if (colorMatch) {
      return new ColoredText({
        color: colorMatch[1] ?? "",
        children: [new Text({ value: colorMatch[2] ?? "" })]
      })
    }

    // Highlight
    const bgMatch = html.match(/<span style="background-color:\s*([^;]+);">([^<]*)<\/span>/)
    if (bgMatch) {
      return new Highlight({
        backgroundColor: bgMatch[1] ?? "",
        children: [new Text({ value: bgMatch[2] ?? "" })]
      })
    }

    return null
  })

/**
 * Parse comment-encoded task list.
 * Format: <!--cf:tasklist:id|uuid|status|body;id|uuid|status|body-->
 */
const parseTaskListComment = (html: string): Effect.Effect<TaskList | null, ParseError> =>
  Effect.gen(function*() {
    // Check if this is a task list
    const match = html.match(/<!--cf:tasklist:(.*)-->/)
    if (!match) {
      return null
    }

    const itemsStr = match[1] ?? ""
    const items: Array<TaskItem> = []

    for (const itemStr of itemsStr.split(";")) {
      const parts = itemStr.split("|")
      if (parts.length >= 4) {
        items.push({
          _tag: "TaskItem" as const,
          id: parts[0] ?? "",
          uuid: parts[1] ?? "",
          status: (parts[2] === "complete" ? "complete" : "incomplete") as "incomplete" | "complete",
          body: [new Text({ value: decodeURIComponent(parts[3] ?? "") })]
        })
      }
    }

    if (items.length === 0) {
      return null
    }

    return {
      _tag: "TaskList" as const,
      version: 1,
      children: items
    }
  })

/**
 * Parse block-level HTML that contains comment-encoded inline elements.
 * Wraps them in a paragraph if found.
 */
const parseBlockLevelInlineComment = (html: string): Effect.Effect<Paragraph | null, ParseError> =>
  Effect.gen(function*() {
    // Check for patterns that should be inline within a paragraph
    const inlinePattern = /<!--cf:(emoticon|user|date):/
    if (!inlinePattern.test(html)) {
      return null
    }

    // Parse the text which may contain multiple inline elements
    const parsed = yield* parseTextWithEmbeddedHtml(html)
    if (parsed.length === 0) {
      return null
    }

    // Filter out empty text nodes
    const nonEmpty = parsed.filter((n) => n._tag !== "Text" || (n as Text).value.trim() !== "")
    if (nonEmpty.length === 0) {
      return null
    }

    return new Paragraph({ children: parsed })
  })

/**
 * Parse comment-encoded image.
 * Format: <!--cf:image:f=filename|v=version|s=src|a=alt|t=title|al=align|w=width-->
 */
const parseImageComment = (html: string): Effect.Effect<Image | null, ParseError> =>
  Effect.gen(function*() {
    const match = html.match(/<!--cf:image:(.*)-->/)
    if (!match) {
      return null
    }

    const partsStr = match[1] ?? ""
    const props: Record<string, string> = {}

    for (const part of partsStr.split("|")) {
      const [key, ...valueParts] = part.split("=")
      if (key) {
        props[key] = valueParts.join("=")
      }
    }

    const attachment = props["f"]
      ? {
        filename: decodeURIComponent(props["f"]),
        version: props["v"] ? parseInt(props["v"], 10) : undefined
      }
      : undefined

    return new Image({
      src: props["s"] ? decodeURIComponent(props["s"]) : undefined,
      alt: props["a"] ? decodeURIComponent(props["a"]) : undefined,
      title: props["t"] ? decodeURIComponent(props["t"]) : undefined,
      align: props["al"] ?? undefined,
      width: props["w"] ? parseInt(props["w"], 10) : undefined,
      attachment
    })
  })

/**
 * Parse comment-encoded expand macro.
 * Format: <!--cf:expand:title:content-->
 */
type ExpandMacroResult = {
  _tag: "ExpandMacro"
  version: number
  title?: string
  children: Array<Heading | Paragraph | CodeBlock | ThematicBreak | Image | Table | UnsupportedBlock>
}

const parseExpandMacroComment = (html: string): Effect.Effect<ExpandMacroResult | null, ParseError> =>
  Effect.gen(function*() {
    const match = html.match(/<!--cf:expand:([^:]*):(.*)-->/)
    if (!match) {
      return null
    }

    const titleStr = decodeURIComponent(match[1] ?? "")
    const content = decodeURIComponent(match[2] ?? "")

    // Parse content as simple paragraphs
    const children: Array<Paragraph> = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => new Paragraph({ children: [new Text({ value: line })] }))

    const result: ExpandMacroResult = {
      _tag: "ExpandMacro",
      version: 1,
      children
    }
    if (titleStr) {
      result.title = titleStr
    }
    return result
  })

/**
 * Parse comment-encoded panel (from :::type container syntax).
 * Format: <!--cf:panel:type:title:content-->
 */
const parsePanelComment = (html: string): Effect.Effect<InfoPanel | null, ParseError> =>
  Effect.gen(function*() {
    const match = html.match(/<!--cf:panel:(\w+):([^:]*):(.*)-->/)
    if (!match) {
      return null
    }

    const panelType = match[1] ?? "info"
    const titleStr = decodeURIComponent(match[2] ?? "")
    const content = decodeURIComponent(match[3] ?? "")

    // Verify panel type is valid
    if (!(PanelTypes as ReadonlyArray<string>).includes(panelType)) {
      return null
    }

    // Parse content as simple paragraphs
    const children: Array<Paragraph> = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => new Paragraph({ children: [new Text({ value: line })] }))

    return {
      _tag: "InfoPanel" as const,
      version: 1,
      panelType: panelType as (typeof PanelTypes)[number],
      ...(titleStr ? { title: titleStr } : {}),
      children
    } satisfies InfoPanel
  })

/**
 * Parse comment-encoded TOC macro.
 * Format: <!--cf:toc:minLevel;maxLevel-->
 */
const parseTocComment = (html: string): Effect.Effect<TocMacro | null, ParseError> =>
  Effect.gen(function*() {
    const match = html.match(/<!--cf:toc:([^;]*);([^;]*)-->/)
    if (!match) {
      return null
    }

    const minStr = match[1] ?? ""
    const maxStr = match[2] ?? ""

    return {
      _tag: "TocMacro" as const,
      version: 1,
      minLevel: minStr ? parseInt(minStr) : undefined,
      maxLevel: maxStr ? parseInt(maxStr) : undefined
    } satisfies TocMacro
  })

/**
 * Parse comment-encoded Status macro(s).
 * Format: <!--cf:status:title;color-->
 * Returns a paragraph containing all status macros found.
 */
const parseStatusComment = (html: string): Effect.Effect<Paragraph | null, ParseError> =>
  Effect.gen(function*() {
    // Match all status comments in the string
    const statusPattern = /<!--cf:status:([^;]*);([^;]*)-->/g
    const matches = [...html.matchAll(statusPattern)]

    if (matches.length === 0) {
      return null
    }

    // Create StatusMacro nodes wrapped in UnsupportedInline for now
    // (since StatusMacro isn't an InlineNode)
    const children: Array<InlineNode> = []
    let lastIndex = 0

    for (const match of matches) {
      // Add any text/whitespace between matches (preserve spaces)
      if (match.index !== undefined && match.index > lastIndex) {
        const textBetween = html.slice(lastIndex, match.index)
        if (textBetween) {
          children.push(new Text({ value: textBetween }))
        }
      }

      // Add status as UnsupportedInline to preserve through roundtrip
      children.push(
        new UnsupportedInline({
          raw: match[0],
          source: "markdown"
        })
      )

      lastIndex = (match.index ?? 0) + match[0].length
    }

    // Add any trailing text
    if (lastIndex < html.length) {
      const trailing = html.slice(lastIndex)
      if (trailing.trim()) {
        children.push(new Text({ value: trailing }))
      }
    }

    return new Paragraph({ children })
  })

/**
 * Parse comment-encoded Smart link.
 * Format: <!--cf:smartlink:href;appearance;datasource-->
 */
const parseSmartLinkComment = (html: string): Effect.Effect<Paragraph | null, ParseError> =>
  Effect.gen(function*() {
    const match = html.match(/<!--cf:smartlink:([^;]*);([^;]*);(.*)-->/)
    if (!match) {
      return null
    }

    // Preserve as UnsupportedInline for roundtrip
    return new Paragraph({
      children: [
        new UnsupportedInline({
          raw: html.trim(),
          source: "markdown"
        })
      ]
    })
  })

/**
 * Parse comment-encoded Decision list.
 * Format: <!--cf:decision:localId;state;content|localId;state;content-->
 */
const parseDecisionComment = (html: string): Effect.Effect<UnsupportedBlock | null, ParseError> =>
  Effect.gen(function*() {
    const match = html.match(/<!--cf:decision:(.*)-->/)
    if (!match) {
      return null
    }

    // Preserve as UnsupportedBlock with the raw comment for roundtrip
    return new UnsupportedBlock({
      rawHtml: html.trim(),
      source: "markdown"
    })
  })

/**
 * Parse layout marker comments.
 * Markers:
 * - <!--cf:layout-start-->
 * - <!--cf:section:index;type;breakoutMode;breakoutWidth;cellCount-->
 * - <!--cf:cell:sectionIndex;cellIndex-->
 * - <!--cf:section-end:index-->
 * - <!--cf:layout-end-->
 */
const parseLayoutComment = (html: string): Effect.Effect<UnsupportedBlock | null, ParseError> =>
  Effect.gen(function*() {
    // Check for any layout marker pattern
    if (
      html.trim() === "<!--cf:layout-start-->" ||
      html.trim() === "<!--cf:layout-end-->" ||
      /<!--cf:section:\d+;[^;]*;[^;]*;[^;]*;\d+-->/.test(html) ||
      /<!--cf:section-end:\d+-->/.test(html) ||
      /<!--cf:cell:\d+;\d+-->/.test(html)
    ) {
      // Preserve as UnsupportedBlock with the raw comment for roundtrip
      return new UnsupportedBlock({
        rawHtml: html.trim(),
        source: "markdown"
      })
    }

    return null
  })

/**
 * Parse text that may contain embedded HTML patterns not recognized by remark.
 * This handles ac: and ri: namespaced elements that remark treats as text.
 */
const parseTextWithEmbeddedHtml = (text: string): Effect.Effect<Array<InlineNode>, ParseError> =>
  Effect.gen(function*() {
    const nodes: Array<InlineNode> = []

    // Pattern to match all embedded HTML we care about (comment-encoded)
    // Use non-greedy match for content since account IDs can contain dashes
    // Date can be empty, so use .*? instead of .+?
    const htmlPattern = /<!--cf:emoticon:.+?-->|<!--cf:user:.+?-->|<!--cf:date:.*?-->/g

    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = htmlPattern.exec(text)) !== null) {
      // Add text before the match
      if (match.index > lastIndex) {
        nodes.push(new Text({ value: text.slice(lastIndex, match.index) }))
      }

      // Parse the HTML match
      const parsed = yield* parseInlineHtml(match[0])
      if (parsed) {
        nodes.push(parsed)
      } else {
        // If we can't parse it, keep as text
        nodes.push(new Text({ value: match[0] }))
      }

      lastIndex = match.index + match[0].length
    }

    // Add remaining text
    if (lastIndex < text.length) {
      nodes.push(new Text({ value: text.slice(lastIndex) }))
    }

    // If no matches, return original text
    if (nodes.length === 0) {
      nodes.push(new Text({ value: text }))
    }

    return nodes
  })

/**
 * Convert mdast children to base inline nodes.
 */
const mdastChildrenToBaseInline = (
  children: Array<MdastNode>
): Effect.Effect<Array<Text | InlineCode | LineBreak | UnsupportedInline>, ParseError> =>
  Effect.gen(function*() {
    const nodes: Array<Text | InlineCode | LineBreak | UnsupportedInline> = []
    for (const child of children) {
      switch (child.type) {
        case "text": {
          const text = child as MdastText
          nodes.push(new Text({ value: text.value }))
          break
        }
        case "inlineCode": {
          const code = child as MdastInlineCode
          nodes.push(new InlineCode({ value: code.value }))
          break
        }
        case "break": {
          nodes.push(new LineBreak({}))
          break
        }
        default: {
          nodes.push(new UnsupportedInline({ raw: JSON.stringify(child), source: "markdown" }))
        }
      }
    }
    return nodes
  })

/**
 * Convert mdast children to simple block nodes.
 */
const mdastChildrenToSimpleBlocks = (
  children: Array<MdastNode>
): Effect.Effect<
  Array<Heading | Paragraph | CodeBlock | ThematicBreak | Image | Table | UnsupportedBlock>,
  ParseError
> =>
  Effect.gen(function*() {
    const blocks: Array<Heading | Paragraph | CodeBlock | ThematicBreak | Image | Table | UnsupportedBlock> = []
    for (const child of children) {
      switch (child.type) {
        case "heading": {
          const heading = child as MdastHeading
          const inlineChildren = yield* mdastChildrenToInline(heading.children)
          blocks.push(new Heading({ level: heading.depth, children: inlineChildren }))
          break
        }
        case "paragraph": {
          const para = child as MdastParagraph
          const inlineChildren = yield* mdastChildrenToInline(para.children)
          blocks.push(new Paragraph({ children: inlineChildren }))
          break
        }
        case "code": {
          const code = child as MdastCode
          blocks.push(new CodeBlock({ code: code.value, language: code.lang || undefined }))
          break
        }
        case "thematicBreak": {
          blocks.push(new ThematicBreak({}))
          break
        }
        case "image": {
          const img = child as MdastImage
          blocks.push(new Image({ src: img.url, alt: img.alt || undefined }))
          break
        }
        case "table": {
          const table = child as MdastTable
          blocks.push(yield* parseTable(table))
          break
        }
        case "html": {
          // HTML nodes in list items - preserve as-is for roundtrip
          // Trim leading/trailing whitespace that remark may add
          const html = child as MdastHtml
          blocks.push(new UnsupportedBlock({ rawHtml: html.value.trim(), source: "markdown" }))
          break
        }
        case "list": {
          // Nested lists - when markdown nested lists are parsed, we lose Confluence local-ids
          // This should rarely happen as Confluence nested lists are preserved as HTML
          blocks.push(new UnsupportedBlock({ rawMarkdown: "", source: "markdown" }))
          break
        }
        default: {
          blocks.push(new UnsupportedBlock({ rawMarkdown: JSON.stringify(child), source: "markdown" }))
        }
      }
    }
    return blocks
  })

// Type for simple blocks used in lists
type SimpleBlock = Heading | Paragraph | CodeBlock | ThematicBreak | Image | Table | UnsupportedBlock

/**
 * Parse mdast list.
 */
const parseList = (
  list: MdastList
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
    const ordered = list.ordered === true
    const start = ordered && list.start != null ? list.start : undefined

    for (const item of list.children) {
      const children = yield* mdastChildrenToSimpleBlocks(item.children)
      if (item.checked != null) {
        items.push({ _tag: "ListItem", checked: item.checked, children })
      } else {
        items.push({ _tag: "ListItem", children })
      }
    }

    if (start !== undefined) {
      return { _tag: "List" as const, version: 1, ordered, start, children: items }
    }
    return { _tag: "List" as const, version: 1, ordered, children: items }
  })

/**
 * Parse mdast table.
 */
const parseTable = (table: MdastTable): Effect.Effect<Table, ParseError> =>
  Effect.gen(function*() {
    let header: TableRow | undefined
    const rows: Array<TableRow> = []

    for (let i = 0; i < table.children.length; i++) {
      const row = table.children[i]
      if (!row) continue
      const cells: Array<TableCell> = []

      for (const cell of row.children) {
        const children = yield* mdastChildrenToInline(cell.children)
        const isHeader = i === 0
        cells.push(new TableCell({ isHeader, children }))
      }

      const tableRow = new TableRow({ cells })
      if (i === 0) {
        header = tableRow
      } else {
        rows.push(tableRow)
      }
    }

    return new Table({ header, rows })
  })
