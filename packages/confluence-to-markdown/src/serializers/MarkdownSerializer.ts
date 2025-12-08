/**
 * Serializer for AST to Markdown.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import type { CodeBlock, Heading, Image, Paragraph, Table, ThematicBreak, UnsupportedBlock } from "../ast/BlockNode.js"
import type { Document, DocumentNode } from "../ast/Document.js"
import type { InlineNode } from "../ast/InlineNode.js"
import type { SerializeError } from "../SchemaConverterError.js"

/**
 * Serialize Document AST to Markdown.
 *
 * @example
 * ```typescript
 * import { serializeToMarkdown } from "@knpkv/confluence-to-markdown/serializers/MarkdownSerializer"
 * import { makeDocument, Heading, Text } from "@knpkv/confluence-to-markdown/ast"
 * import { Effect } from "effect"
 *
 * Effect.gen(function* () {
 *   const doc = makeDocument([
 *     new Heading({ level: 1, children: [new Text({ value: "Title" })] })
 *   ])
 *   const md = yield* serializeToMarkdown(doc)
 *   console.log(md) // # Title
 * })
 * ```
 *
 * @category Serializers
 */
export interface SerializeOptions {
  /** Include raw Confluence HTML for lossless roundtrip. Default: true */
  readonly includeRawSource?: boolean
}

export const serializeToMarkdown = (
  doc: Document,
  options: SerializeOptions = {}
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const { includeRawSource = true } = options
    const parts: Array<string> = []
    for (const node of doc.children) {
      const serialized = yield* serializeDocumentNode(node)
      parts.push(serialized)
    }

    const content = parts.join("\n\n")

    // Embed rawConfluence in comment for 1-to-1 roundtrip preservation
    if (includeRawSource && doc.rawConfluence !== undefined) {
      // Encode entire raw HTML for roundtrip
      const encoded = Buffer.from(doc.rawConfluence, "utf-8").toString("base64")
      return `${content}\n\n<!--cf:raw:${encoded}-->`
    }

    return content
  })

/**
 * Serialize a document node to Markdown.
 */
const serializeDocumentNode = (node: DocumentNode): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    switch (node._tag) {
      // Block nodes
      case "Heading":
        return yield* serializeHeading(node)
      case "Paragraph":
        return yield* serializeParagraph({
          children: node.children,
          alignment: node.alignment,
          indent: node.indent
        })
      case "CodeBlock":
        return serializeCodeBlock(node)
      case "ThematicBreak":
        return "---"
      case "Image":
        return serializeImage(node)
      case "Table":
        return yield* serializeTable(node)
      case "List":
        return yield* serializeList(node)
      case "BlockQuote":
        return yield* serializeBlockQuote(node)
      case "UnsupportedBlock":
        return node.rawMarkdown || node.rawHtml || ""

      // Macro nodes
      case "InfoPanel":
        return yield* serializeInfoPanel(node)
      case "ExpandMacro":
        return yield* serializeExpandMacro(node)
      case "TocMacro":
        return serializeTocMacro(node)
      case "CodeMacro":
        return serializeCodeMacro(node)
      case "StatusMacro":
        return serializeStatusMacro(node)
      case "TaskList":
        return yield* serializeTaskList(node.children)

      default:
        return ""
    }
  })

/**
 * Serialize heading.
 */
const serializeHeading = (
  node: { level: 1 | 2 | 3 | 4 | 5 | 6; children: ReadonlyArray<InlineNode> }
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const prefix = "#".repeat(node.level)
    const content = yield* serializeInlineNodes(node.children)
    return `${prefix} ${content}`
  })

/**
 * Serialize paragraph.
 */
const serializeParagraph = (
  node: {
    children: ReadonlyArray<InlineNode>
    alignment?: "left" | "center" | "right" | undefined
    indent?: number | undefined
  }
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const content = yield* serializeInlineNodes(node.children)
    // If has alignment or indent, wrap in HTML div for roundtrip
    if (node.alignment || node.indent) {
      const styles: Array<string> = []
      if (node.alignment) styles.push(`text-align: ${node.alignment};`)
      if (node.indent) styles.push(`margin-left: ${node.indent}px;`)
      return `<p style="${styles.join(" ")}">${content}</p>`
    }
    return content
  })

/**
 * Serialize code block.
 */
const serializeCodeBlock = (node: { code: string; language?: string | undefined }): string => {
  const lang = node.language || ""
  return `\`\`\`${lang}\n${node.code}\n\`\`\``
}

/**
 * Serialize image (supports both URL and Confluence attachments).
 * Uses comment-encoding for attachments to preserve roundtrip fidelity.
 */
const serializeImage = (node: {
  src?: string | undefined
  attachment?: { filename: string; version?: number | undefined } | undefined
  alt?: string | undefined
  title?: string | undefined
  align?: string | undefined
  width?: number | undefined
}): string => {
  // If image has attachment or align/width, use comment encoding for roundtrip
  if (node.attachment || node.align || node.width) {
    const parts: Array<string> = []
    if (node.attachment) {
      parts.push(`f=${encodeURIComponent(node.attachment.filename)}`)
      if (node.attachment.version) parts.push(`v=${node.attachment.version}`)
    }
    if (node.src) parts.push(`s=${encodeURIComponent(node.src)}`)
    if (node.alt) parts.push(`a=${encodeURIComponent(node.alt)}`)
    if (node.title) parts.push(`t=${encodeURIComponent(node.title)}`)
    if (node.align) parts.push(`al=${node.align}`)
    if (node.width) parts.push(`w=${node.width}`)
    return `<!--cf:image:${parts.join("|")}-->`
  }

  // Simple external image - use markdown syntax
  const alt = node.alt || ""
  const title = node.title ? ` "${node.title}"` : ""
  const src = node.src || ""
  return `![${alt}](${src}${title})`
}

/**
 * Serialize table.
 */
const serializeTable = (
  node: {
    header?: { cells: ReadonlyArray<{ children: ReadonlyArray<InlineNode> }> } | undefined
    rows: ReadonlyArray<{ cells: ReadonlyArray<{ children: ReadonlyArray<InlineNode> }> }>
  }
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const lines: Array<string> = []

    // Header
    if (node.header) {
      const headerCells: Array<string> = []
      for (const cell of node.header.cells) {
        headerCells.push(yield* serializeInlineNodes(cell.children))
      }
      lines.push(`| ${headerCells.join(" | ")} |`)
      lines.push(`| ${headerCells.map(() => "---").join(" | ")} |`)
    }

    // Body rows
    for (const row of node.rows) {
      const cells: Array<string> = []
      for (const cell of row.cells) {
        cells.push(yield* serializeInlineNodes(cell.children))
      }
      lines.push(`| ${cells.join(" | ")} |`)
    }

    return lines.join("\n")
  })

// Simple block type for list items
type SimpleBlock =
  | Heading
  | Paragraph
  | CodeBlock
  | ThematicBreak
  | Image
  | Table
  | UnsupportedBlock

// List item type
type ListItemType = {
  readonly _tag: "ListItem"
  readonly checked?: boolean | undefined
  readonly children: ReadonlyArray<SimpleBlock>
}

/**
 * Serialize list.
 */
const serializeList = (
  node: { ordered: boolean; start?: number | undefined; children: ReadonlyArray<ListItemType> }
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const lines: Array<string> = []
    let counter = node.start || 1

    for (const item of node.children) {
      const prefix = node.ordered ? `${counter}.` : "-"
      const checkbox = item.checked !== undefined ? (item.checked ? "[x] " : "[ ] ") : ""

      // Serialize item content
      const itemParts: Array<string> = []
      for (const child of item.children) {
        const serialized = yield* serializeSimpleBlock(child)
        itemParts.push(serialized)
      }

      const content = itemParts.join("\n")
      const indentedContent = content
        .split("\n")
        .map((line, i) => (i === 0 ? `${prefix} ${checkbox}${line}` : `   ${line}`))
        .join("\n")

      lines.push(indentedContent)
      counter++
    }

    return lines.join("\n")
  })

/**
 * Serialize simple block (for nested content).
 */
const serializeSimpleBlock = (node: SimpleBlock): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    switch (node._tag) {
      case "Heading":
        return yield* serializeHeading(
          node as unknown as { level: 1 | 2 | 3 | 4 | 5 | 6; children: ReadonlyArray<InlineNode> }
        )
      case "Paragraph":
        return yield* serializeParagraph(node as unknown as { children: ReadonlyArray<InlineNode> })
      case "CodeBlock":
        return serializeCodeBlock(node as unknown as { code: string; language?: string | undefined })
      case "ThematicBreak":
        return "---"
      case "Image":
        return serializeImage(node as unknown as { src: string; alt?: string | undefined; title?: string | undefined })
      case "Table":
        return yield* serializeTable(
          node as unknown as {
            header?: { cells: ReadonlyArray<{ children: ReadonlyArray<InlineNode> }> } | undefined
            rows: ReadonlyArray<{ cells: ReadonlyArray<{ children: ReadonlyArray<InlineNode> }> }>
          }
        )
      case "UnsupportedBlock": {
        const unsupported = node as unknown as { rawMarkdown?: string; rawHtml?: string }
        return unsupported.rawMarkdown || unsupported.rawHtml || ""
      }
      default:
        return ""
    }
  })

/**
 * Serialize block quote.
 */
const serializeBlockQuote = (
  node: { children: ReadonlyArray<SimpleBlock> }
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const lines: Array<string> = []
    for (const child of node.children) {
      const serialized = yield* serializeSimpleBlock(child as SimpleBlock)
      const quoted = serialized.split("\n").map((line) => `> ${line}`).join("\n")
      lines.push(quoted)
    }
    return lines.join("\n>\n")
  })

/**
 * Serialize info panel to container syntax.
 */
const serializeInfoPanel = (
  node: { panelType: string; title?: string | undefined; children: ReadonlyArray<SimpleBlock> }
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const type = node.panelType
    const title = node.title ? ` ${node.title}` : ""
    const lines: Array<string> = [`:::${type}${title}`]

    for (const child of node.children) {
      const serialized = yield* serializeSimpleBlock(child as SimpleBlock)
      lines.push(serialized)
    }

    lines.push(":::")
    return lines.join("\n")
  })

/**
 * Serialize expand macro - use comment encoding for roundtrip.
 */
const serializeExpandMacro = (
  node: { title?: string | undefined; children: ReadonlyArray<SimpleBlock> }
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const title = node.title || ""
    const contentParts: Array<string> = []

    for (const child of node.children) {
      const serialized = yield* serializeSimpleBlock(child as SimpleBlock)
      contentParts.push(serialized)
    }

    const content = contentParts.join("\n")
    // Use comment encoding for roundtrip
    return `<!--cf:expand:${encodeURIComponent(title)}:${encodeURIComponent(content)}-->`
  })

/**
 * Serialize TOC macro.
 */
const serializeTocMacro = (_node: { minLevel?: number | undefined; maxLevel?: number | undefined }): string => {
  return "[[toc]]"
}

/**
 * Serialize code macro (similar to code block but may have title).
 */
const serializeCodeMacro = (
  node: { language?: string | undefined; title?: string | undefined; code: string }
): string => {
  const lang = node.language || ""
  const title = node.title ? ` title="${node.title}"` : ""
  return `\`\`\`${lang}${title}\n${node.code}\n\`\`\``
}

/**
 * Serialize status macro.
 */
const serializeStatusMacro = (node: { text: string; color: string }): string => {
  return `**[${node.text}]**`
}

/**
 * Serialize task list - preserve as comment-encoded for roundtrip (single line).
 */
const serializeTaskList = (
  children: ReadonlyArray<{
    _tag: "TaskItem"
    id: string
    uuid: string
    status: "incomplete" | "complete"
    body: ReadonlyArray<InlineNode>
  }>
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const items: Array<string> = []
    for (const item of children) {
      const body = yield* serializeInlineNodes(item.body)
      // Encode task item - use | separator to avoid : in content issues
      items.push(`${item.id}|${item.uuid}|${item.status}|${encodeURIComponent(body)}`)
    }
    // Single line comment to prevent remark from splitting
    return `<!--cf:tasklist:${items.join(";")}-->`
  })

/**
 * Serialize inline nodes to Markdown.
 */
const serializeInlineNodes = (
  nodes: ReadonlyArray<InlineNode>
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const parts: Array<string> = []
    for (const node of nodes) {
      parts.push(yield* serializeInlineNode(node))
    }
    return parts.join("")
  })

/**
 * Serialize inline node to Markdown.
 */
const serializeInlineNode = (node: InlineNode): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    switch (node._tag) {
      case "Text":
        return node.value
      case "Strong": {
        const content = yield* serializeInlineNodes(node.children)
        return `**${content}**`
      }
      case "Emphasis": {
        const content = yield* serializeInlineNodes(node.children)
        return `*${content}*`
      }
      case "Underline": {
        // No native markdown support, use HTML
        const content = yield* serializeInlineNodes(node.children)
        return `<u>${content}</u>`
      }
      case "Strikethrough": {
        const content = yield* serializeInlineNodes(node.children)
        return `~~${content}~~`
      }
      case "Subscript": {
        // No native markdown support, use HTML
        const content = yield* serializeInlineNodes(node.children)
        return `<sub>${content}</sub>`
      }
      case "Superscript": {
        // No native markdown support, use HTML
        const content = yield* serializeInlineNodes(node.children)
        return `<sup>${content}</sup>`
      }
      case "InlineCode":
        return `\`${node.value}\``
      case "Link": {
        const content = yield* serializeInlineNodes(node.children)
        const title = node.title ? ` "${node.title}"` : ""
        return `[${content}](${node.href}${title})`
      }
      case "LineBreak":
        return "  \n"
      case "Emoticon":
        // Wrap in HTML comment with URL-encoded values
        return `<!--cf:emoticon:${encodeURIComponent(node.shortname)}|${encodeURIComponent(node.emojiId)}|${
          encodeURIComponent(node.fallback)
        }-->`
      case "UserMention":
        // Wrap in HTML comment to prevent remark from parsing
        return `<!--cf:user:${node.accountId}-->`
      case "DateTime":
        // Wrap in HTML comment to prevent remark from parsing
        return `<!--cf:date:${node.datetime}-->`
      case "ColoredText": {
        // Preserve as HTML for roundtrip
        const content = yield* serializeInlineNodes(node.children)
        return `<span style="color: ${node.color};">${content}</span>`
      }
      case "Highlight": {
        // Preserve as HTML for roundtrip
        const content = yield* serializeInlineNodes(node.children)
        return `<span style="background-color: ${node.backgroundColor};">${content}</span>`
      }
      case "UnsupportedInline":
        return node.raw
      default:
        return ""
    }
  })
