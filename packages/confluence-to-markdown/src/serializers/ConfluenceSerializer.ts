/**
 * Serializer for AST to Confluence storage format (HTML).
 *
 * @module
 */
import * as Effect from "effect/Effect"
import type { CodeBlock, Heading, Image, Paragraph, Table, ThematicBreak, UnsupportedBlock } from "../ast/BlockNode.js"
import type { Document, DocumentNode } from "../ast/Document.js"
import type { InlineNode } from "../ast/InlineNode.js"
import type { SerializeError } from "../SchemaConverterError.js"

/**
 * Serialize Document AST to Confluence storage format HTML.
 *
 * @example
 * ```typescript
 * import { serializeToConfluence } from "@knpkv/confluence-to-markdown/serializers/ConfluenceSerializer"
 * import { makeDocument, Heading, Text } from "@knpkv/confluence-to-markdown/ast"
 * import { Effect } from "effect"
 *
 * Effect.gen(function* () {
 *   const doc = makeDocument([
 *     new Heading({ level: 1, children: [new Text({ value: "Title" })] })
 *   ])
 *   const html = yield* serializeToConfluence(doc)
 *   console.log(html) // <h1>Title</h1>
 * })
 * ```
 *
 * @category Serializers
 */
export const serializeToConfluence = (doc: Document): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    // 1-to-1 roundtrip: if rawConfluence is available, return it as-is
    if (doc.rawConfluence !== undefined) {
      return doc.rawConfluence
    }

    const parts: Array<string> = []
    for (const node of doc.children) {
      const serialized = yield* serializeDocumentNode(node)
      parts.push(serialized)
    }
    const raw = parts.join("\n")
    // Post-process to reconstruct layouts from markers
    return reconstructLayouts(raw)
  })

/**
 * Reconstruct layouts from marker comments.
 *
 * Markers:
 * - <!--cf:layout-start-->
 * - <!--cf:section:index;type;breakoutMode;breakoutWidth;cellCount-->
 * - <!--cf:cell:sectionIndex;cellIndex-->
 * - <!--cf:section-end:index-->
 * - <!--cf:layout-end-->
 */
const reconstructLayouts = (html: string): string => {
  // Check if there are any layout markers
  if (!html.includes("<!--cf:layout-start-->")) {
    return html
  }

  let result = html

  // Process each layout block
  const layoutRegex = /<!--cf:layout-start-->([\s\S]*?)<!--cf:layout-end-->/g
  result = result.replace(layoutRegex, (_, layoutContent: string) => {
    // Parse sections from the content
    const sections: Array<{
      type: string
      breakoutMode: string
      breakoutWidth: string
      cells: Array<string>
    }> = []

    // Find all section markers
    const sectionRegex = /<!--cf:section:(\d+);([^;]*);([^;]*);([^;]*);(\d+)-->/g
    let sectionMatch
    const sectionMeta: Array<
      { index: number; type: string; breakoutMode: string; breakoutWidth: string; cellCount: number }
    > = []

    while ((sectionMatch = sectionRegex.exec(layoutContent)) !== null) {
      sectionMeta.push({
        index: parseInt(sectionMatch[1] ?? "0"),
        type: decodeURIComponent(sectionMatch[2] ?? "fixed-width"),
        breakoutMode: decodeURIComponent(sectionMatch[3] ?? ""),
        breakoutWidth: decodeURIComponent(sectionMatch[4] ?? ""),
        cellCount: parseInt(sectionMatch[5] ?? "0")
      })
    }

    // For each section, extract cell content
    for (const meta of sectionMeta) {
      const cells: Array<string> = []

      for (let cellIndex = 0; cellIndex < meta.cellCount; cellIndex++) {
        const cellStartMarker = `<!--cf:cell:${meta.index};${cellIndex}-->`
        const nextCellMarker = `<!--cf:cell:${meta.index};${cellIndex + 1}-->`
        const sectionEndMarker = `<!--cf:section-end:${meta.index}-->`
        const nextSectionMarker = `<!--cf:section:${meta.index + 1};`

        const cellStart = layoutContent.indexOf(cellStartMarker)
        if (cellStart === -1) continue

        const contentStart = cellStart + cellStartMarker.length

        // Find where this cell ends - either next cell, section end, or next section
        let cellEnd = layoutContent.length
        const nextCell = layoutContent.indexOf(nextCellMarker, contentStart)
        const secEnd = layoutContent.indexOf(sectionEndMarker, contentStart)
        const nextSec = layoutContent.indexOf(nextSectionMarker, contentStart)

        if (nextCell !== -1 && nextCell < cellEnd) cellEnd = nextCell
        if (secEnd !== -1 && secEnd < cellEnd) cellEnd = secEnd
        if (nextSec !== -1 && nextSec < cellEnd) cellEnd = nextSec

        const cellContent = layoutContent.slice(contentStart, cellEnd).trim()
        cells.push(cellContent)
      }

      sections.push({
        type: meta.type,
        breakoutMode: meta.breakoutMode,
        breakoutWidth: meta.breakoutWidth,
        cells
      })
    }

    // Build the layout HTML
    const sectionHtml = sections.map((section) => {
      const typeAttr = ` ac:type="${escapeHtml(section.type)}"`
      const breakoutModeAttr = section.breakoutMode ? ` ac:breakout-mode="${escapeHtml(section.breakoutMode)}"` : ""
      const breakoutWidthAttr = section.breakoutWidth ? ` ac:breakout-width="${escapeHtml(section.breakoutWidth)}"` : ""
      const cellsHtml = section.cells.map((c) => `<ac:layout-cell>${c}</ac:layout-cell>`).join("")
      return `<ac:layout-section${typeAttr}${breakoutModeAttr}${breakoutWidthAttr}>${cellsHtml}</ac:layout-section>`
    }).join("")

    return `<ac:layout>${sectionHtml}</ac:layout>`
  })

  return result
}

/**
 * Serialize a document node to Confluence HTML.
 */
const serializeDocumentNode = (node: DocumentNode): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    switch (node._tag) {
      // Block nodes
      case "Heading":
        return yield* serializeHeading({ level: node.level, children: node.children })
      case "Paragraph":
        return yield* serializeParagraph({
          children: node.children,
          alignment: node.alignment,
          indent: node.indent
        })
      case "CodeBlock":
        return serializeCodeBlock({ code: node.code, language: node.language })
      case "ThematicBreak":
        return "<hr/>"
      case "Image":
        return serializeImage({
          src: node.src,
          attachment: node.attachment,
          alt: node.alt,
          title: node.title,
          align: node.align,
          width: node.width
        })
      case "Table":
        return yield* serializeTable({ header: node.header, rows: node.rows })
      case "List":
        return yield* serializeList({
          ordered: node.ordered,
          start: node.start,
          children: node.children as unknown as Array<ListItemType>
        })
      case "BlockQuote":
        return yield* serializeBlockQuote({ children: node.children as unknown as Array<SimpleBlock> })
      case "UnsupportedBlock": {
        const raw = node.rawHtml || node.rawMarkdown || ""
        // Check for comment-encoded decision list
        const decisionMatch = raw.match(/<!--cf:decision:(.*)-->/)
        if (decisionMatch) {
          const itemsStr = decisionMatch[1] ?? ""
          const items = itemsStr.split("|").map((item) => {
            const parts = item.split(";")
            return {
              localId: decodeURIComponent(parts[0] ?? ""),
              state: decodeURIComponent(parts[1] ?? ""),
              content: decodeURIComponent(parts[2] ?? "")
            }
          })
          const decisionItems = items.map((item) =>
            `<ac:adf-node type="decision-item"><ac:adf-attribute key="local-id">${
              escapeHtml(item.localId)
            }</ac:adf-attribute><ac:adf-attribute key="state">${
              escapeHtml(item.state)
            }</ac:adf-attribute><ac:adf-content>${escapeHtml(item.content)}</ac:adf-content></ac:adf-node>`
          ).join("")
          const fallbackItems = items.map((item) => `<li>${escapeHtml(item.content)}</li>`).join("")
          return `<ac:adf-extension><ac:adf-node type="decision-list">${decisionItems}</ac:adf-node><ac:adf-fallback><ul class="decision-list">${fallbackItems}</ul></ac:adf-fallback></ac:adf-extension>`
        }
        // Layout markers are passed through - reconstructLayouts will process them
        return raw
      }

      // Macro nodes - serialize to Confluence macros
      case "InfoPanel":
        return yield* serializeInfoPanel({
          panelType: node.panelType,
          title: node.title,
          children: node.children as unknown as Array<SimpleBlock>
        })
      case "ExpandMacro":
        return yield* serializeExpandMacro({
          title: node.title,
          children: node.children as unknown as Array<SimpleBlock>
        })
      case "TocMacro":
        return serializeTocMacro({ minLevel: node.minLevel, maxLevel: node.maxLevel })
      case "CodeMacro":
        return serializeCodeMacro({
          language: node.language,
          title: node.title,
          code: node.code,
          lineNumbers: node.lineNumbers,
          collapse: node.collapse,
          firstLine: node.firstLine
        })
      case "StatusMacro":
        return serializeStatusMacro({ text: node.text, color: node.color })
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
    const content = yield* serializeInlineNodes(node.children)
    return `<h${node.level}>${content}</h${node.level}>`
  })

/**
 * Serialize paragraph (with optional alignment and indent).
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
    const styles: Array<string> = []
    if (node.alignment) {
      styles.push(`text-align: ${node.alignment};`)
    }
    if (node.indent) {
      styles.push(`margin-left: ${node.indent}px;`)
    }
    const styleAttr = styles.length > 0 ? ` style="${styles.join(" ")}"` : ""
    return `<p${styleAttr}>${content}</p>`
  })

/**
 * Serialize code block as Confluence code macro.
 */
const serializeCodeBlock = (node: { code: string; language?: string | undefined }): string => {
  const lang = node.language ? `<ac:parameter ac:name="language">${escapeHtml(node.language)}</ac:parameter>` : ""
  return `<ac:structured-macro ac:name="code">${lang}<ac:plain-text-body><![CDATA[${node.code}]]></ac:plain-text-body></ac:structured-macro>`
}

/**
 * Serialize image (supports both URL and Confluence attachments).
 */
const serializeImage = (node: {
  src?: string | undefined
  attachment?: { filename: string; version?: number | undefined } | undefined
  alt?: string | undefined
  title?: string | undefined
  align?: string | undefined
  width?: number | undefined
}): string => {
  // Confluence attachment
  if (node.attachment) {
    const alignAttr = node.align ? ` ac:align="${node.align}"` : ""
    const widthAttr = node.width ? ` ac:width="${node.width}"` : ""
    const altAttr = node.alt ? ` ac:alt="${escapeHtml(node.alt)}"` : ""
    const versionAttr = node.attachment.version ? ` ri:version-at-save="${node.attachment.version}"` : ""
    return `<ac:image${alignAttr}${widthAttr}${altAttr}><ri:attachment ri:filename="${
      escapeHtml(node.attachment.filename)
    }"${versionAttr}/></ac:image>`
  }

  // URL-based image
  const src = node.src ?? ""
  const alt = node.alt ? ` alt="${escapeHtml(node.alt)}"` : ""
  const title = node.title ? ` title="${escapeHtml(node.title)}"` : ""
  return `<img src="${escapeHtml(src)}"${alt}${title}/>`
}

/**
 * Serialize table.
 */
const serializeTable = (
  node: {
    header?:
      | { cells: ReadonlyArray<{ isHeader?: boolean | undefined; children: ReadonlyArray<InlineNode> }> }
      | undefined
    rows: ReadonlyArray<
      { cells: ReadonlyArray<{ isHeader?: boolean | undefined; children: ReadonlyArray<InlineNode> }> }
    >
  }
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const parts: Array<string> = ["<table>"]

    // Header
    if (node.header) {
      parts.push("<thead><tr>")
      for (const cell of node.header.cells) {
        const content = yield* serializeInlineNodes(cell.children)
        parts.push(`<th>${content}</th>`)
      }
      parts.push("</tr></thead>")
    }

    // Body
    if (node.rows.length > 0) {
      parts.push("<tbody>")
      for (const row of node.rows) {
        parts.push("<tr>")
        for (const cell of row.cells) {
          const tag = cell.isHeader ? "th" : "td"
          const content = yield* serializeInlineNodes(cell.children)
          parts.push(`<${tag}>${content}</${tag}>`)
        }
        parts.push("</tr>")
      }
      parts.push("</tbody>")
    }

    parts.push("</table>")
    return parts.join("")
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
    const tag = node.ordered ? "ol" : "ul"
    const startAttr = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : ""
    const parts: Array<string> = [`<${tag}${startAttr}>`]

    for (const item of node.children) {
      parts.push("<li>")
      if (item.checked !== undefined) {
        const checked = item.checked ? " checked" : ""
        parts.push(`<input type="checkbox"${checked}/>`)
      }
      for (const child of item.children) {
        parts.push(yield* serializeSimpleBlock(child))
      }
      parts.push("</li>")
    }

    parts.push(`</${tag}>`)
    return parts.join("")
  })

/**
 * Serialize simple block.
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
        return "<hr/>"
      case "Image":
        return serializeImage(node as unknown as { src: string; alt?: string | undefined; title?: string | undefined })
      case "Table":
        return yield* serializeTable(
          node as unknown as {
            header?:
              | { cells: ReadonlyArray<{ isHeader?: boolean | undefined; children: ReadonlyArray<InlineNode> }> }
              | undefined
            rows: ReadonlyArray<
              { cells: ReadonlyArray<{ isHeader?: boolean | undefined; children: ReadonlyArray<InlineNode> }> }
            >
          }
        )
      case "UnsupportedBlock": {
        const unsupported = node as unknown as { rawHtml?: string; rawMarkdown?: string }
        return unsupported.rawHtml || unsupported.rawMarkdown || ""
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
    const parts: Array<string> = ["<blockquote>"]
    for (const child of node.children) {
      parts.push(yield* serializeSimpleBlock(child as SimpleBlock))
    }
    parts.push("</blockquote>")
    return parts.join("")
  })

/**
 * Serialize info panel as Confluence macro.
 */
const serializeInfoPanel = (
  node: { panelType: string; title?: string | undefined; children: ReadonlyArray<SimpleBlock> }
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const titleParam = node.title
      ? `<ac:parameter ac:name="title">${escapeHtml(node.title)}</ac:parameter>`
      : ""

    const parts: Array<string> = [
      `<ac:structured-macro ac:name="${node.panelType}">`,
      titleParam,
      "<ac:rich-text-body>"
    ]

    for (const child of node.children) {
      parts.push(yield* serializeSimpleBlock(child as SimpleBlock))
    }

    parts.push("</ac:rich-text-body>")
    parts.push("</ac:structured-macro>")
    return parts.join("")
  })

/**
 * Serialize expand macro as Confluence macro.
 */
const serializeExpandMacro = (
  node: { title?: string | undefined; children: ReadonlyArray<SimpleBlock> }
): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    const titleParam = node.title
      ? `<ac:parameter ac:name="title">${escapeHtml(node.title)}</ac:parameter>`
      : ""

    const parts: Array<string> = [
      `<ac:structured-macro ac:name="expand">`,
      titleParam,
      "<ac:rich-text-body>"
    ]

    for (const child of node.children) {
      parts.push(yield* serializeSimpleBlock(child as SimpleBlock))
    }

    parts.push("</ac:rich-text-body>")
    parts.push("</ac:structured-macro>")
    return parts.join("")
  })

/**
 * Serialize TOC macro.
 */
const serializeTocMacro = (node: { minLevel?: number | undefined; maxLevel?: number | undefined }): string => {
  const params: Array<string> = []
  if (node.minLevel) {
    params.push(`<ac:parameter ac:name="minLevel">${node.minLevel}</ac:parameter>`)
  }
  if (node.maxLevel) {
    params.push(`<ac:parameter ac:name="maxLevel">${node.maxLevel}</ac:parameter>`)
  }
  return `<ac:structured-macro ac:name="toc">${params.join("")}</ac:structured-macro>`
}

/**
 * Serialize code macro with full options.
 */
const serializeCodeMacro = (
  node: {
    language?: string | undefined
    title?: string | undefined
    code: string
    lineNumbers?: boolean | undefined
    collapse?: boolean | undefined
    firstLine?: number | undefined
  }
): string => {
  const params: Array<string> = []
  if (node.language) {
    params.push(`<ac:parameter ac:name="language">${escapeHtml(node.language)}</ac:parameter>`)
  }
  if (node.title) {
    params.push(`<ac:parameter ac:name="title">${escapeHtml(node.title)}</ac:parameter>`)
  }
  if (node.lineNumbers) {
    params.push(`<ac:parameter ac:name="linenumbers">true</ac:parameter>`)
  }
  if (node.collapse) {
    params.push(`<ac:parameter ac:name="collapse">true</ac:parameter>`)
  }
  if (node.firstLine) {
    params.push(`<ac:parameter ac:name="firstline">${node.firstLine}</ac:parameter>`)
  }

  return `<ac:structured-macro ac:name="code">${
    params.join("")
  }<ac:plain-text-body><![CDATA[${node.code}]]></ac:plain-text-body></ac:structured-macro>`
}

/**
 * Serialize status macro.
 */
const serializeStatusMacro = (node: { text: string; color: string }): string => {
  return `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${
    escapeHtml(node.color)
  }</ac:parameter><ac:parameter ac:name="title">${escapeHtml(node.text)}</ac:parameter></ac:structured-macro>`
}

/**
 * Serialize task list to Confluence storage format.
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
    const parts: Array<string> = [`<ac:task-list>`]

    for (const item of children) {
      const body = yield* serializeInlineNodes(item.body)
      parts.push(
        `<ac:task>` +
          `<ac:task-id>${item.id}</ac:task-id>` +
          `<ac:task-uuid>${item.uuid}</ac:task-uuid>` +
          `<ac:task-status>${item.status}</ac:task-status>` +
          `<ac:task-body><span class="placeholder-inline-tasks">${body}</span></ac:task-body>` +
          `</ac:task>`
      )
    }

    parts.push(`</ac:task-list>`)
    return parts.join("\n")
  })

/**
 * Serialize inline nodes to HTML.
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
 * Serialize inline node to HTML.
 */
const serializeInlineNode = (node: InlineNode): Effect.Effect<string, SerializeError> =>
  Effect.gen(function*() {
    switch (node._tag) {
      case "Text":
        return escapeHtml(node.value)
      case "Strong": {
        const content = yield* serializeInlineNodes(node.children)
        return `<strong>${content}</strong>`
      }
      case "Emphasis": {
        const content = yield* serializeInlineNodes(node.children)
        return `<em>${content}</em>`
      }
      case "Underline": {
        const content = yield* serializeInlineNodes(node.children)
        return `<u>${content}</u>`
      }
      case "Strikethrough": {
        const content = yield* serializeInlineNodes(node.children)
        return `<del>${content}</del>`
      }
      case "Subscript": {
        const content = yield* serializeInlineNodes(node.children)
        return `<sub>${content}</sub>`
      }
      case "Superscript": {
        const content = yield* serializeInlineNodes(node.children)
        return `<sup>${content}</sup>`
      }
      case "InlineCode":
        return `<code>${escapeHtml(node.value)}</code>`
      case "Link": {
        const content = yield* serializeInlineNodes(node.children)
        const title = node.title ? ` title="${escapeHtml(node.title)}"` : ""
        return `<a href="${escapeHtml(node.href)}"${title}>${content}</a>`
      }
      case "LineBreak":
        return "<br/>"
      case "Emoticon":
        return `<ac:emoticon ac:emoji-shortname="${escapeHtml(node.shortname)}" ac:emoji-id="${
          escapeHtml(node.emojiId)
        }" ac:emoji-fallback="${escapeHtml(node.fallback)}"/>`
      case "UserMention":
        return `<ac:link><ri:user ri:account-id="${escapeHtml(node.accountId)}"/></ac:link>`
      case "DateTime":
        return `<time datetime="${escapeHtml(node.datetime)}"/>`
      case "ColoredText": {
        const content = yield* serializeInlineNodes(node.children)
        return `<span style="color: ${escapeHtml(node.color)};">${content}</span>`
      }
      case "Highlight": {
        const content = yield* serializeInlineNodes(node.children)
        return `<span style="background-color: ${escapeHtml(node.backgroundColor)};">${content}</span>`
      }
      case "UnsupportedInline": {
        // Check for comment-encoded TOC and convert back to Confluence macro
        const tocMatch = node.raw.match(/<!--cf:toc:([^;]*);([^;]*)-->/)
        if (tocMatch) {
          const minLevel = tocMatch[1]
          const maxLevel = tocMatch[2]
          let params = ""
          if (minLevel) params += `<ac:parameter ac:name="minLevel">${minLevel}</ac:parameter>`
          if (maxLevel) params += `<ac:parameter ac:name="maxLevel">${maxLevel}</ac:parameter>`
          return `<ac:structured-macro ac:name="toc">${params}</ac:structured-macro>`
        }
        // Check for comment-encoded Status macro
        const statusMatch = node.raw.match(/<!--cf:status:([^;]*);([^;]*)-->/)
        if (statusMatch) {
          const title = decodeURIComponent(statusMatch[1] ?? "")
          const color = decodeURIComponent(statusMatch[2] ?? "")
          let params = ""
          if (title) params += `<ac:parameter ac:name="title">${escapeHtml(title)}</ac:parameter>`
          if (color) params += `<ac:parameter ac:name="colour">${escapeHtml(color)}</ac:parameter>`
          return `<ac:structured-macro ac:name="status">${params}</ac:structured-macro>`
        }
        // Check for comment-encoded Smart link (Jira, etc.)
        const smartLinkMatch = node.raw.match(/<!--cf:smartlink:([^;]*);([^;]*);(.*)-->/)
        if (smartLinkMatch) {
          const href = decodeURIComponent(smartLinkMatch[1] ?? "")
          const appearance = decodeURIComponent(smartLinkMatch[2] ?? "")
          const datasource = decodeURIComponent(smartLinkMatch[3] ?? "")
          return `<a href="${escapeHtml(href)}" data-card-appearance="${escapeHtml(appearance)}" data-datasource="${
            escapeHtml(datasource)
          }">${escapeHtml(href)}</a>`
        }
        return node.raw
      }
      default:
        return ""
    }
  })

/**
 * Escape HTML special characters.
 */
const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
