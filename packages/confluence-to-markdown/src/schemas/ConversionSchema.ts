/**
 * Direct conversion schema: Confluence HTML <-> Markdown.
 *
 * Composes preprocessing, parsing, and serialization into a single transform.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import type { BlockNode } from "../ast/BlockNode.js"
import { type Document, makeDocument } from "../ast/Document.js"
import type { MacroNode } from "../ast/MacroNode.js"
import type { HastElement, HastNode, HastRoot } from "./hast/index.js"
import { HastFromHtml, isHastElement } from "./hast/index.js"
import type { MdastBlockContent, MdastRoot } from "./mdast/index.js"
import { MdastFromMarkdown } from "./mdast/index.js"
import { blockNodeFromHastElement, blockNodeFromMdast, blockNodeToMdast } from "./nodes/index.js"
import { macroNodeFromHastElement, macroNodeToMdast } from "./nodes/macro/index.js"
import { PreprocessedHtmlFromConfluence } from "./preprocessing/index.js"

type DocumentNode = BlockNode | MacroNode

/**
 * Parse HAST children to simple block nodes.
 */
const parseBlockChildren = (
  children: ReadonlyArray<HastNode>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Effect.Effect<ReadonlyArray<any>, ParseResult.ParseError> =>
  Effect.forEach(
    children.filter(isHastElement),
    (el) =>
      blockNodeFromHastElement(el).pipe(
        Effect.map((node) => node as BlockNode | null),
        Effect.map((node) => (node !== null ? [node] : [])),
        Effect.map((arr) => arr as ReadonlyArray<BlockNode>)
      )
  ).pipe(Effect.map((arrays) => arrays.flat()))

/**
 * Parse single HAST element to document node (block or macro).
 */
const documentNodeFromHastElement = (
  element: HastElement
): Effect.Effect<DocumentNode | null, ParseResult.ParseError> =>
  Effect.gen(function*() {
    // Try macro first
    const macro = yield* macroNodeFromHastElement(element, parseBlockChildren)
    if (macro !== null) {
      return macro
    }

    // Fall back to block
    const block = yield* blockNodeFromHastElement(element)
    return block
  })

/**
 * Parse HAST root to Document AST.
 */
const documentFromHastRoot = (
  root: HastRoot,
  rawConfluence?: string
): Effect.Effect<Document, ParseResult.ParseError> =>
  Effect.gen(function*() {
    const elements = root.children.filter(isHastElement)
    const nodeArrays = yield* Effect.forEach(elements, (el) =>
      documentNodeFromHastElement(el).pipe(
        Effect.map((node) => (node !== null ? [node] : []))
      ))
    const children = nodeArrays.flat()
    return makeDocument(children, rawConfluence)
  })

/**
 * Parse MDAST root to Document AST.
 */
const documentFromMdastRoot = (root: MdastRoot): Document => {
  const children: Array<DocumentNode> = []
  for (const node of root.children) {
    const blockContent = node as MdastBlockContent
    const block = blockNodeFromMdast(blockContent)
    children.push(block)
  }
  return makeDocument(children)
}

/**
 * Check if node is a macro node.
 */
const isMacroNode = (node: DocumentNode): node is MacroNode => {
  return node._tag === "InfoPanel" ||
    node._tag === "ExpandMacro" ||
    node._tag === "TocMacro" ||
    node._tag === "CodeMacro" ||
    node._tag === "StatusMacro"
}

/**
 * Serialize Document AST to Markdown.
 */
const documentToMarkdown = (doc: Document): string => {
  const parts: Array<string> = []
  for (const node of doc.children) {
    const mdast = isMacroNode(node)
      ? macroNodeToMdast(node)
      : blockNodeToMdast(node as BlockNode)
    parts.push(mdastToString(mdast))
  }
  return parts.join("\n\n")
}

/**
 * Convert MDAST block content to string.
 */
const mdastToString = (node: MdastBlockContent): string => {
  switch (node.type) {
    case "paragraph":
      return node.children.map((c) => {
        if (c.type === "text") return c.value
        if (c.type === "inlineCode") return `\`${c.value}\``
        if (c.type === "strong") return `**${c.children.map((t) => (t as { value: string }).value).join("")}**`
        if (c.type === "emphasis") return `_${c.children.map((t) => (t as { value: string }).value).join("")}_`
        if (c.type === "link") return `[${c.children.map((t) => (t as { value: string }).value).join("")}](${c.url})`
        if (c.type === "delete") return `~~${c.children.map((t) => (t as { value: string }).value).join("")}~~`
        if (c.type === "break") return "  \n"
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
    case "blockquote":
      return node.children.map((c) => "> " + mdastToString(c as MdastBlockContent)).join("\n")
    case "list":
      return node.children.map((item, i) => {
        const prefix = node.ordered ? `${(node.start ?? 1) + i}. ` : "- "
        const content = (item as { children: ReadonlyArray<MdastBlockContent> }).children
          .map((c) => mdastToString(c)).join("\n")
        return prefix + content
      }).join("\n")
    case "table": {
      if (!node.children.length) return ""
      const headerRow = node.children[0]
      if (!headerRow) return ""
      const headerCells =
        (headerRow as { children: ReadonlyArray<{ children: ReadonlyArray<MdastBlockContent> }> }).children
      const header = "| " + headerCells.map((cell) => cell.children.map((c) => mdastToString(c)).join("")).join(" | ") +
        " |"
      const separator = "| " + headerCells.map(() => "---").join(" | ") + " |"
      const rows = node.children.slice(1).map((row) => {
        const cells = (row as { children: ReadonlyArray<{ children: ReadonlyArray<MdastBlockContent> }> }).children
        return "| " + cells.map((cell) => cell.children.map((c) => mdastToString(c)).join("")).join(" | ") +
          " |"
      })
      return [header, separator, ...rows].join("\n")
    }
    default:
      return ""
  }
}

/**
 * Schema for transforming preprocessed Confluence HTML to Document AST.
 */
export const DocumentFromHast: Schema.Schema<
  Document,
  HastRoot,
  never
> = Schema.transformOrFail(
  Schema.Any as Schema.Schema<HastRoot, HastRoot>,
  Schema.Any as Schema.Schema<Document, Document>,
  {
    strict: true,
    decode: (root, _options, ast) =>
      documentFromHastRoot(root).pipe(
        Effect.mapError((e) => new ParseResult.Type(ast, root, e.message))
      ),
    encode: (_doc, _options, ast) =>
      Effect.fail(new ParseResult.Type(ast, _doc, "Document to HAST encoding not implemented"))
  }
)

/**
 * Schema for transforming MDAST root to Document AST.
 */
export const DocumentFromMdast: Schema.Schema<
  Document,
  MdastRoot,
  never
> = Schema.transformOrFail(
  Schema.Any as Schema.Schema<MdastRoot, MdastRoot>,
  Schema.Any as Schema.Schema<Document, Document>,
  {
    strict: true,
    decode: (root, _options, _ast) => Effect.succeed(documentFromMdastRoot(root)),
    encode: (_doc, _options, ast) =>
      Effect.fail(new ParseResult.Type(ast, _doc, "Document to MDAST encoding not implemented"))
  }
)

/**
 * Direct conversion schema: Confluence HTML string <-> Markdown string.
 *
 * @example
 * ```typescript
 * import { ConfluenceToMarkdown } from "@knpkv/confluence-to-markdown/schemas/ConversionSchema"
 * import { Schema, Effect } from "effect"
 *
 * // Decode: Confluence HTML -> Markdown
 * const markdown = Effect.runSync(
 *   Schema.decode(ConfluenceToMarkdown)(confluenceHtml)
 * )
 *
 * // Encode: Markdown -> Confluence HTML (limited support)
 * const html = Effect.runSync(
 *   Schema.encode(ConfluenceToMarkdown)(markdown)
 * )
 * ```
 *
 * @category Schemas
 */
export const ConfluenceToMarkdown: Schema.Schema<
  string,
  string,
  never
> = Schema.transformOrFail(
  Schema.String,
  Schema.String,
  {
    strict: true,
    decode: (html, _options, ast) =>
      Effect.gen(function*() {
        // Preprocess
        const preprocessed = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html).pipe(
          Effect.mapError((e) => new ParseResult.Type(ast, html, `Preprocessing failed: ${e.message}`))
        )

        // Parse to HAST
        const hast = yield* Schema.decode(HastFromHtml)(preprocessed).pipe(
          Effect.mapError((e) => new ParseResult.Type(ast, html, `HAST parsing failed: ${e.message}`))
        )

        // Convert to Document
        const doc = yield* documentFromHastRoot(hast, html).pipe(
          Effect.mapError((e) => new ParseResult.Type(ast, html, `Document conversion failed: ${e.message}`))
        )

        // Serialize to Markdown
        return documentToMarkdown(doc)
      }),
    encode: (md, _options, ast) =>
      Schema.decode(MdastFromMarkdown)(md).pipe(
        Effect.mapError((e) => new ParseResult.Type(ast, md, `MDAST parsing failed: ${e.message}`)),
        Effect.map((mdast) => {
          // Convert to Document
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc = documentFromMdastRoot(mdast as any)

          // Note: Full HTML serialization is complex; return basic HTML
          // For full fidelity, use the existing ConfluenceSerializer
          const parts: Array<string> = []
          for (const node of doc.children) {
            parts.push(documentNodeToHtml(node))
          }
          return parts.join("\n")
        })
      )
  }
)

/**
 * Basic document node to HTML conversion.
 */
const documentNodeToHtml = (node: DocumentNode): string => {
  switch (node._tag) {
    case "Heading":
      return `<h${node.level}>${node.children.map(inlineToHtml).join("")}</h${node.level}>`
    case "Paragraph":
      return `<p>${node.children.map(inlineToHtml).join("")}</p>`
    case "CodeBlock":
      return `<pre><code${node.language ? ` class="language-${node.language}"` : ""}>${
        escapeHtml(node.code)
      }</code></pre>`
    case "ThematicBreak":
      return "<hr />"
    case "Image":
      return `<img src="${escapeHtml(node.src ?? "")}" alt="${escapeHtml(node.alt ?? "")}" />`
    case "BlockQuote":
      return `<blockquote>${node.children.map((c) => documentNodeToHtml(c as DocumentNode)).join("")}</blockquote>`
    case "List": {
      const tag = node.ordered ? "ol" : "ul"
      return `<${tag}>${
        node.children.map((item) =>
          `<li>${item.children.map((c) => documentNodeToHtml(c as DocumentNode)).join("")}</li>`
        ).join("")
      }</${tag}>`
    }
    case "Table":
      return `<table>${
        node.rows.map((row) =>
          `<tr>${
            row.cells.map((cell) =>
              cell.isHeader
                ? `<th>${cell.children.map(inlineToHtml).join("")}</th>`
                : `<td>${cell.children.map(inlineToHtml).join("")}</td>`
            ).join("")
          }</tr>`
        ).join("")
      }</table>`
    case "InfoPanel":
      return `<div data-macro="${node.panelType}">${
        node.children.map((c) => documentNodeToHtml(c as DocumentNode)).join("")
      }</div>`
    case "ExpandMacro":
      return `<details><summary>${escapeHtml(node.title ?? "")}</summary>${
        node.children.map((c) => documentNodeToHtml(c as DocumentNode)).join("")
      }</details>`
    case "TocMacro":
      return `<nav data-macro="toc"></nav>`
    case "CodeMacro":
      return `<pre data-macro="code"${node.language ? ` data-language="${node.language}"` : ""}><code>${
        escapeHtml(node.code)
      }</code></pre>`
    case "StatusMacro":
      return `<span data-macro="status" data-color="${node.color}">${escapeHtml(node.text)}</span>`
    default:
      return ""
  }
}

/**
 * Basic inline node to HTML.
 */
const inlineToHtml = (
  node: { _tag: string; value?: string; children?: ReadonlyArray<unknown>; url?: string }
): string => {
  switch (node._tag) {
    case "Text":
      return escapeHtml(node.value ?? "")
    case "Strong":
      return `<strong>${
        (node.children as ReadonlyArray<{ _tag: string; value?: string }>)?.map(inlineToHtml).join("") ?? ""
      }</strong>`
    case "Emphasis":
      return `<em>${
        (node.children as ReadonlyArray<{ _tag: string; value?: string }>)?.map(inlineToHtml).join("") ?? ""
      }</em>`
    case "InlineCode":
      return `<code>${escapeHtml(node.value ?? "")}</code>`
    case "Link":
      return `<a href="${escapeHtml(node.url ?? "")}">${
        (node.children as ReadonlyArray<{ _tag: string; value?: string }>)?.map(inlineToHtml).join("") ?? ""
      }</a>`
    case "LineBreak":
      return "<br />"
    default:
      return ""
  }
}

/**
 * Escape HTML special characters.
 */
const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
