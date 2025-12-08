/**
 * Parser for Confluence storage format (HTML) to AST.
 *
 * @module
 */
import * as Effect from "effect/Effect"
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

/** Maximum HTML input size (1MB) to prevent ReDoS attacks */
const MAX_HTML_SIZE = 1024 * 1024

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
    if (html.length > MAX_HTML_SIZE) {
      return yield* Effect.fail(
        new ParseError({
          source: "confluence",
          message: `HTML input too large: ${html.length} bytes (max ${MAX_HTML_SIZE})`
        })
      )
    }

    // Pre-process Confluence macros
    const preprocessed = yield* preprocessConfluenceMacros(html)

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
 * Pre-process Confluence macros into parseable HTML.
 */
const preprocessConfluenceMacros = (html: string): Effect.Effect<string, ParseError> =>
  Effect.gen(function*() {
    let result = html

    // Process layouts FIRST - before any other preprocessing to preserve raw cell content
    result = preprocessLayouts(result)

    let iterations = 0
    const maxIterations = 100

    // Process structured macros iteratively
    while (iterations < maxIterations) {
      const macroStart = result.indexOf("<ac:structured-macro")
      if (macroStart === -1) break

      // Find matching closing tag
      let depth = 1
      let pos = macroStart + 20
      let endPos = -1

      while (pos < result.length && depth > 0) {
        if (result.slice(pos, pos + 20) === "<ac:structured-macro") {
          depth++
          pos += 20
        } else if (result.slice(pos, pos + 21) === "</ac:structured-macro") {
          depth--
          if (depth === 0) {
            endPos = result.indexOf(">", pos) + 1
          }
          pos += 21
        } else {
          pos++
        }
      }

      if (endPos === -1) break

      const macroContent = result.slice(macroStart, endPos)
      const replacement = yield* processMacro(macroContent)
      result = result.slice(0, macroStart) + replacement + result.slice(endPos)
      iterations++
    }

    // Process task lists BEFORE stripping ac: tags
    result = preprocessTaskLists(result)

    // Process images with attachments BEFORE stripping
    result = preprocessImages(result)

    // Process emoticons BEFORE stripping
    result = preprocessEmoticons(result)

    // Process user mentions BEFORE stripping
    result = preprocessUserMentions(result)

    // Process ADF extensions (decision lists) BEFORE stripping
    result = preprocessAdfExtensions(result)

    // Remove remaining ac/ri tags
    result = result
      .replace(/<ac:parameter[^>]{0,1000}>[^<]{0,10000}<\/ac:parameter>/gi, "")
      .replace(/<\/?ac:[a-z-]{1,50}[^>]{0,1000}>/gi, "")
      .replace(/<\/?ri:[a-z-]{1,50}[^>]{0,1000}\/?>/gi, "")

    return result
  })

/**
 * Preprocess task lists.
 * <ac:task-list><ac:task><ac:task-id>43</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>text</ac:task-body></ac:task></ac:task-list>
 * -> <ul data-macro="task-list"><li data-task-id="43" data-task-status="incomplete">text</li></ul>
 */
const preprocessTaskLists = (html: string): string => {
  // Process individual tasks - use a more flexible approach
  let result = html
  const taskRegex = /<ac:task>([\s\S]*?)<\/ac:task>/gi
  result = result.replace(taskRegex, (_, taskContent) => {
    const idMatch = taskContent.match(/<ac:task-id>([^<]*)<\/ac:task-id>/)
    const uuidMatch = taskContent.match(/<ac:task-uuid>([^<]*)<\/ac:task-uuid>/)
    const statusMatch = taskContent.match(/<ac:task-status>([^<]*)<\/ac:task-status>/)
    const bodyMatch = taskContent.match(/<ac:task-body>([\s\S]*?)<\/ac:task-body>/)

    const id = idMatch?.[1] ?? ""
    const uuid = uuidMatch?.[1] ?? ""
    const status = statusMatch?.[1] ?? "incomplete"
    const body = bodyMatch?.[1] ?? ""
    // Strip inner HTML tags from body
    const cleanBody = body.replace(/<[^>]+>/g, "").trim()
    return `<li data-task-id="${id}" data-task-uuid="${uuid}" data-task-status="${status}">${cleanBody}</li>`
  })
  // Wrap task-list
  result = result.replace(/<ac:task-list[^>]*>/gi, "<ul data-macro=\"task-list\">")
  result = result.replace(/<\/ac:task-list>/gi, "</ul>")
  return result
}

/**
 * Preprocess images with attachments.
 * <ac:image ac:align="center" ac:width="250"><ri:attachment ri:filename="foo.svg"/></ac:image>
 * -> <img data-attachment="foo.svg" data-align="center" data-width="250">
 */
const preprocessImages = (html: string): string => {
  return html.replace(
    /<ac:image([^>]*)>[\s\S]*?<ri:attachment([^>]*)\/>[\s\S]*?<\/ac:image>/gi,
    (_, imageAttrs, attachmentAttrs) => {
      const filename = attachmentAttrs.match(/ri:filename="([^"]*)"/)?.[1] ?? ""
      const align = imageAttrs.match(/ac:align="([^"]*)"/)?.[1] ?? ""
      const width = imageAttrs.match(/ac:width="([^"]*)"/)?.[1] ?? ""
      const alt = imageAttrs.match(/ac:alt="([^"]*)"/)?.[1] ?? ""
      const attrs = [
        `data-attachment="${escapeHtml(filename)}"`,
        align && `data-align="${align}"`,
        width && `data-width="${width}"`,
        alt && `alt="${escapeHtml(alt)}"`
      ].filter(Boolean).join(" ")
      return `<img ${attrs}>`
    }
  )
}

/**
 * Preprocess emoticons.
 * <ac:emoticon ac:emoji-shortname=":grinning:" ac:emoji-id="1f600" ac:emoji-fallback="😀"/>
 * -> <span data-emoji=":grinning:" data-emoji-id="1f600">😀</span>
 */
const preprocessEmoticons = (html: string): string => {
  return html.replace(
    /<ac:emoticon([^>]*)\/?>/gi,
    (_, attrs) => {
      const shortname = attrs.match(/ac:emoji-shortname="([^"]*)"/)?.[1] ?? ""
      const emojiId = attrs.match(/ac:emoji-id="([^"]*)"/)?.[1] ?? ""
      const fallback = attrs.match(/ac:emoji-fallback="([^"]*)"/)?.[1] ?? ""
      return `<span data-emoji="${escapeHtml(shortname)}" data-emoji-id="${emojiId}">${fallback}</span>`
    }
  )
}

/**
 * Preprocess user mentions.
 * <ac:link><ri:user ri:account-id="557058:..."/></ac:link>
 * -> <span data-user-mention="557058:..."></span>
 */
const preprocessUserMentions = (html: string): string => {
  return html.replace(
    /<ac:link>\s*<ri:user([^>]*)\/?>\s*<\/ac:link>/gi,
    (_, attrs) => {
      const accountId = attrs.match(/ri:account-id="([^"]*)"/)?.[1] ?? ""
      return `<span data-user-mention="${escapeHtml(accountId)}"></span>`
    }
  )
}

/**
 * Preprocess ADF extensions (decision lists).
 * Extracts decision items and encodes them for roundtrip.
 */
const preprocessAdfExtensions = (html: string): string => {
  // Match ADF extension blocks
  return html.replace(
    /<ac:adf-extension>([\s\S]*?)<\/ac:adf-extension>/gi,
    (_, content) => {
      // Check if it's a decision list - extract items directly from the content
      // since decision-item nodes are nested inside decision-list
      if (content.includes("type=\"decision-list\"")) {
        const items: Array<{ localId: string; state: string; content: string }> = []
        // Match decision items - use greedy match to get full content
        const itemRegex = /<ac:adf-node\s+type="decision-item">([\s\S]*?)<\/ac:adf-node>/gi
        let itemMatch
        while ((itemMatch = itemRegex.exec(content)) !== null) {
          const itemContent = itemMatch[1] ?? ""
          const localIdMatch = itemContent.match(/<ac:adf-attribute\s+key="local-id">([^<]*)<\/ac:adf-attribute>/)
          const stateMatch = itemContent.match(/<ac:adf-attribute\s+key="state">([^<]*)<\/ac:adf-attribute>/)
          const textMatch = itemContent.match(/<ac:adf-content>([^<]*)<\/ac:adf-content>/)
          items.push({
            localId: localIdMatch?.[1] ?? "",
            state: stateMatch?.[1] ?? "UNDECIDED",
            content: textMatch?.[1] ?? ""
          })
        }
        if (items.length > 0) {
          // Encode as comment for roundtrip
          const encoded = items.map((item) =>
            `${encodeURIComponent(item.localId)};${encodeURIComponent(item.state)};${encodeURIComponent(item.content)}`
          ).join("|")
          return `<!--cf:decision:${encoded}-->`
        }
      }
      // Check if it's an ADF panel (note, info, warning, etc.)
      if (content.includes("type=\"panel\"")) {
        const panelTypeMatch = content.match(/<ac:adf-attribute\s+key="panel-type">([^<]*)<\/ac:adf-attribute>/)
        const panelType = panelTypeMatch?.[1] ?? "info"
        const contentMatch = content.match(/<ac:adf-content>([\s\S]*?)<\/ac:adf-content>/)
        const innerContent = contentMatch?.[1] ?? ""
        // Convert to standard panel div format
        return `<div data-macro="${panelType}" data-title="">${innerContent}</div>`
      }
      // Unknown ADF extension - use fallback if available
      const fallbackMatch = content.match(/<ac:adf-fallback>([\s\S]*?)<\/ac:adf-fallback>/)
      if (fallbackMatch) {
        return fallbackMatch[1] ?? ""
      }
      return ""
    }
  )
}

/**
 * Preprocess layouts.
 * Strips Confluence layout wrappers but preserves structure metadata for roundtrip.
 *
 * Strategy:
 * 1. Insert cell boundary markers (<!--cf:cell:N-->) to track which content belongs to which cell
 * 2. Insert section start markers (<!--cf:section:type;breakoutMode;breakoutWidth;cellCount-->)
 * 3. Insert layout start/end markers
 * 4. Let content parse normally - markdown remains readable
 *
 * Note: We wrap markers in <div> to ensure they're at root level after parsing.
 */
const preprocessLayouts = (html: string): string => {
  // Match entire ac:layout blocks
  return html.replace(
    /<ac:layout>([\s\S]*?)<\/ac:layout>/gi,
    (_, layoutContent) => {
      // Use divs to ensure markers are at root level after parsing
      let result = "<div data-cf-marker><!--cf:layout-start--></div>"
      let sectionIndex = 0

      // Extract layout sections
      const sectionRegex = /<ac:layout-section([^>]*)>([\s\S]*?)<\/ac:layout-section>/gi
      let sectionMatch
      while ((sectionMatch = sectionRegex.exec(layoutContent)) !== null) {
        const sectionAttrs = sectionMatch[1] ?? ""
        const sectionContent = sectionMatch[2] ?? ""

        // Extract section type
        const typeMatch = sectionAttrs.match(/ac:type="([^"]*)"/)
        const sectionType = typeMatch?.[1] ?? "fixed-width"

        // Extract breakout attributes
        const breakoutModeMatch = sectionAttrs.match(/ac:breakout-mode="([^"]*)"/)
        const breakoutWidthMatch = sectionAttrs.match(/ac:breakout-width="([^"]*)"/)
        const breakoutMode = breakoutModeMatch?.[1] ?? ""
        const breakoutWidth = breakoutWidthMatch?.[1] ?? ""

        // Count and extract cells
        const cellContents: Array<string> = []
        const cellRegex = /<ac:layout-cell[^>]*>([\s\S]*?)<\/ac:layout-cell>/gi
        let cellMatch
        while ((cellMatch = cellRegex.exec(sectionContent)) !== null) {
          cellContents.push(cellMatch[1] ?? "")
        }

        // Add section marker with metadata (wrapped in div)
        result += `<div data-cf-marker><!--cf:section:${sectionIndex};${encodeURIComponent(sectionType)};${
          encodeURIComponent(breakoutMode)
        };${encodeURIComponent(breakoutWidth)};${cellContents.length}--></div>`

        // Add cell markers and content (wrapped in divs)
        cellContents.forEach((cellContent, cellIndex) => {
          result += `<div data-cf-marker><!--cf:cell:${sectionIndex};${cellIndex}--></div>${cellContent}`
        })

        result += `<div data-cf-marker><!--cf:section-end:${sectionIndex}--></div>`
        sectionIndex++
      }

      result += "<div data-cf-marker><!--cf:layout-end--></div>"
      return result
    }
  )
}

/**
 * Process a single Confluence macro to HTML.
 */
const processMacro = (macroContent: string): Effect.Effect<string, never> =>
  Effect.succeed((() => {
    // Extract macro name
    const nameMatch = macroContent.match(/ac:name="([^"]+)"/)
    const macroName = nameMatch?.[1] ?? ""

    // Extract plain-text body (for code macros)
    const plainBodyStart = macroContent.indexOf("<ac:plain-text-body><![CDATA[")
    const plainBodyEnd = macroContent.indexOf("]]></ac:plain-text-body>")
    if (plainBodyStart !== -1 && plainBodyEnd !== -1) {
      const content = macroContent.slice(plainBodyStart + 29, plainBodyEnd)
      const langMatch = macroContent.match(/ac:name="code".*?<ac:parameter[^>]*ac:name="language"[^>]*>([^<]+)/)
      const language = langMatch?.[1] ?? ""
      return `<pre data-macro="code" data-language="${language}"><code>${escapeHtml(content)}</code></pre>`
    }

    // Extract rich-text body
    const richBodyStart = macroContent.indexOf("<ac:rich-text-body>")
    const richBodyEnd = macroContent.indexOf("</ac:rich-text-body>")
    if (richBodyStart !== -1 && richBodyEnd !== -1) {
      const content = macroContent.slice(richBodyStart + 19, richBodyEnd)

      // Info/warning/note/panel panels
      if ((PanelTypes as ReadonlyArray<string>).includes(macroName)) {
        const titleMatch = macroContent.match(/<ac:parameter[^>]*ac:name="title"[^>]*>([^<]+)/)
        const title = titleMatch?.[1] ?? ""
        return `<div data-macro="${macroName}" data-title="${escapeHtml(title)}">${content}</div>`
      }

      // Expand macro
      if (macroName === "expand") {
        const titleMatch = macroContent.match(/<ac:parameter[^>]*ac:name="title"[^>]*>([^<]+)/)
        const title = titleMatch?.[1] ?? ""
        return `<details data-macro="expand"><summary>${escapeHtml(title)}</summary>${content}</details>`
      }

      return content
    }

    // TOC macro
    if (macroName === "toc") {
      const minMatch = macroContent.match(/<ac:parameter[^>]*ac:name="minLevel"[^>]*>(\d+)/)
      const maxMatch = macroContent.match(/<ac:parameter[^>]*ac:name="maxLevel"[^>]*>(\d+)/)
      return `<nav data-macro="toc" data-min="${minMatch?.[1] ?? ""}" data-max="${maxMatch?.[1] ?? ""}"></nav>`
    }

    // Status macro
    if (macroName === "status") {
      const colorMatch = macroContent.match(/<ac:parameter[^>]*ac:name="colour"[^>]*>([^<]+)/)
      const titleMatch = macroContent.match(/<ac:parameter[^>]*ac:name="title"[^>]*>([^<]+)/)
      return `<span data-macro="status" data-color="${colorMatch?.[1] ?? ""}">${
        escapeHtml(titleMatch?.[1] ?? "")
      }</span>`
    }

    // Unknown macro - preserve as unsupported
    return `<div data-unsupported-macro="${macroName}">${macroContent}</div>`
  })())

const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

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
