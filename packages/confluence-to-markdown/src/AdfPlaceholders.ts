/**
 * Reverse the AdfWalker's placeholder syntax back into proper ADF nodes
 * after the @atlaskit markdown transformer has run.
 *
 * The walker emits Confluence-only nodes (status, extension, inlineExtension)
 * as HTML/comment placeholders so they survive a pull. The markdown transformer
 * has no concept of these nodes, so on push it parses the placeholders as
 * plain text — Confluence then renders the literal HTML/comment. This module
 * walks the produced ADF and rewrites those text patterns into the structured
 * nodes the editor expects.
 *
 * Patterns recognized (must match the AdfWalker emission exactly):
 *  - `<span class="adf-status" data-color="COLOR">TEXT</span>`
 *  - `<!-- adf:extension key=KEY type=TYPE attrs=BASE64 -->`   (block, when
 *      the whole paragraph is just this comment; `attrs` is base64 JSON of
 *      the node's full attrs — parameters, localId, layout — and wins over
 *      the readable key/type parts; key/type-only is the legacy form)
 *  - `<!-- adf:paragraph marks=BASE64 --> BODY <!-- adf:/paragraph -->`
 *      (the body paragraph regains its paragraph-level marks)
 *  - `<!-- adf:bodiedExtension … --> BODY <!-- adf:/bodiedExtension -->`
 *      (the sibling blocks between the markers become the extension's body)
 *  - `<!-- adf:inlineCard attrs=BASE64 -->` (inline)
 *  - `<!-- adf:inlineExtension key=KEY type=TYPE attrs=BASE64 -->` (inline)
 *  - `<!-- adf:date node=BASE64 -->` and `<!-- adf:emoji node=BASE64 -->`
 *      (inline)
 *  - `<!-- adf:panel type=TYPE attrs=BASE64 --> BODY <!-- adf:/panel -->`
 *      (the sibling blocks between the markers become the panel's body)
 *  - `<!-- adf:TYPE node=BASE64 --> BODY <!-- adf:/TYPE -->` for selected
 *      native block nodes such as code blocks with metadata, task/decision
 *      lists, expands, layouts, cards, tables, and media
 *  - `<u>TEXT</u>`, `<sub>TEXT</sub>`, `<sup>TEXT</sup>`, and exact styled
 *      spans emitted for Confluence-only inline marks
 *  - `[@Name](confluence-mention://ACCOUNT_ID)`            (link mark with a
 *      custom scheme — the only way to round-trip mention accountIds)
 *  - `[[toc]]`, `[[toc:min=1,max=3]]` (block-level native syntax for the
 *      Confluence Table of Contents macro)
 *
 * @module
 */

import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

interface AdfNode {
  readonly type: string
  readonly attrs?: Record<string, unknown>
  readonly content?: ReadonlyArray<AdfNode>
  readonly text?: string
  readonly marks?: ReadonlyArray<AdfNode>
}

const STATUS_RE = /<span class="adf-status"\s+data-color="([^"]+)">([^<]*)<\/span>/g
const INLINE_NODE_RE = /<!--\s*adf:(date|emoji)(?:\s+node=([\s\S]*?))?\s*-->/g
const INLINE_CARD_RE = /<!--\s*adf:inlineCard(?:\s+attrs=([\s\S]*?))?\s*-->/g
const INLINE_EXTENSION_RE =
  /<!--\s*adf:inlineExtension(?:\s+key=(\S+?))?(?:\s+type=(\S+?))?(?:\s+attrs=([\s\S]*?))?\s*-->/g
const UNDERLINE_RE = /<u>([^<]*)<\/u>/g
const SUBSCRIPT_RE = /<sub>([^<]*)<\/sub>/g
const SUPERSCRIPT_RE = /<sup>([^<]*)<\/sup>/g
const TEXT_COLOR_RE = /<span style="color:([^"<>]+)">([^<]*)<\/span>/g
const BACKGROUND_COLOR_RE = /<span style="background-color:([^"<>]+)">([^<]*)<\/span>/g
const COMBINED_INLINE_RE = new RegExp(
  [
    INLINE_NODE_RE.source,
    STATUS_RE.source,
    INLINE_CARD_RE.source,
    INLINE_EXTENSION_RE.source,
    UNDERLINE_RE.source,
    SUBSCRIPT_RE.source,
    SUPERSCRIPT_RE.source,
    TEXT_COLOR_RE.source,
    BACKGROUND_COLOR_RE.source
  ].join("|"),
  "g"
)

const BLOCK_EXTENSION_RE =
  /^\s*<!--\s*adf:(extension|bodiedExtension)(?:\s+key=(\S+?))?(?:\s+type=(\S+?))?(?:\s+attrs=([\s\S]*?))?\s*-->\s*$/
const BODIED_EXTENSION_END_RE = /^\s*<!--\s*adf:\/bodiedExtension\s*-->\s*$/
const PANEL_RE = /^\s*<!--\s*adf:panel(?:\s+type=(\S+?))?(?:\s+attrs=([\s\S]*?))?\s*-->\s*$/
const PANEL_END_RE = /^\s*<!--\s*adf:\/panel\s*-->\s*$/
const ENCODED_BLOCK_NODE_RE =
  /^\s*\\*<!--\s*adf:(codeBlock|taskList|decisionList|expand|nestedExpand|table|layoutSection|blockCard|embedCard|mediaSingle|mediaGroup)(?:\s+node=([\s\S]*?))?\s*-->\s*$/
const ENCODED_BLOCK_NODE_END_RE =
  /^\s*\\*<!--\s*adf:\/(codeBlock|taskList|decisionList|expand|nestedExpand|table|layoutSection|blockCard|embedCard|mediaSingle|mediaGroup)\s*-->\s*$/
const PARAGRAPH_MARKS_RE = /^\s*<!--\s*adf:paragraph(?:\s+marks=([\s\S]*?))?\s*-->\s*$/
const PARAGRAPH_MARKS_END_RE = /^\s*<!--\s*adf:\/paragraph\s*-->\s*$/
const TOC_RE = /^\s*\[\[toc(?::([^\]]+))?\]\]\s*$/
const CONFLUENCE_CORE_MACRO_TYPE = "com.atlassian.confluence.macro.core"

const textNode = (text: string, marks: ReadonlyArray<AdfNode> | undefined): AdfNode =>
  marks && marks.length > 0 ? { type: "text", text, marks } : { type: "text", text }

const addMark = (marks: ReadonlyArray<AdfNode> | undefined, mark: AdfNode): ReadonlyArray<AdfNode> =>
  marks && marks.length > 0 ? [...marks, mark] : [mark]

// Code-marked text is a *quotation* of placeholder syntax, not a placeholder
// (the walker never emits placeholders with a code mark) — expanding it would
// corrupt documentation that demonstrates the syntax.
const hasCodeMark = (n: AdfNode): boolean => (n.marks ?? []).some((m) => m.type === "code")

// Parents whose content model permits bodiedExtension per @atlaskit/adf-schema
// (blockquote/listItem/tableCell allow plain extension but NOT bodied — emitting
// one there fails outgoing validation and the whole push errors out).
const BODIED_EXTENSION_PARENTS = new Set(["doc", "layoutColumn"])

// Web APIs only (atob/TextDecoder) — this module is a standalone subpath
// export and must not assume Node, mirroring the walker's encoder.
const fromBase64 = (b64: string): string => {
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

const toBase64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  return btoa(String.fromCharCode(...bytes))
}

// JSON string → free-form attrs record; rejects null/arrays/primitives.
const AttrsBlob = Schema.Record(Schema.String, Schema.Unknown)
const decodeAttrsBlob = Schema.decodeUnknownOption(AttrsBlob)

const decodeAttrs = (b64: string | undefined): Record<string, unknown> | null => {
  if (!b64) return null
  try {
    const raw = b64.trim()
    const parsed = parsePlaceholderJson(raw.startsWith("{") ? raw : fromBase64(raw)) as unknown
    const decoded = decodeAttrsBlob(parsed)
    return Option.isSome(decoded) ? decoded.value : null
  } catch {
    // Invalid JSON/base64 (hand-edited file?) — fall back to the readable key/type.
    return null
  }
}

const buildExtensionAttrs = (
  key: string | undefined,
  type: string | undefined,
  attrsB64: string | undefined
): Record<string, unknown> => {
  const decoded = decodeAttrs(attrsB64)
  if (decoded) return decoded
  const attrs: Record<string, unknown> = {}
  if (key) attrs.extensionKey = key
  if (type) attrs.extensionType = type
  return attrs
}

const buildPanelAttrs = (type: string | undefined, attrsB64: string | undefined): Record<string, unknown> => {
  const decoded = decodeAttrs(attrsB64)
  if (decoded) return decoded
  return type ? { panelType: type } : {}
}

const buildInlineCardAttrs = (attrsB64: string | undefined): Record<string, unknown> => decodeAttrs(attrsB64) ?? {}

const decodeMarks = (b64: string | undefined): ReadonlyArray<AdfNode> => {
  if (!b64) return []
  try {
    const raw = b64.trim()
    const parsed = parsePlaceholderJson(raw.startsWith("[") ? raw : fromBase64(raw)) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((mark): mark is AdfNode =>
        mark !== null && typeof mark === "object" && typeof (mark as Record<string, unknown>)["type"] === "string"
      )
      : []
  } catch {
    return []
  }
}

const decodeNode = (b64: string | undefined): AdfNode | null => {
  if (!b64) return null
  try {
    const raw = b64.trim()
    const parsed = parsePlaceholderJson(raw.startsWith("{") ? raw : fromBase64(raw)) as unknown
    return parsed !== null && typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>)["type"] === "string"
      ? parsed as AdfNode
      : null
  } catch {
    return null
  }
}

const parsePlaceholderJson = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown
  } catch {
    // @atlaskit's markdown parser may insert markdown escapes into placeholder
    // text before we restore it. Square brackets are common inside code-block
    // JSON samples and `\[` / `\]` are invalid JSON escapes.
    return JSON.parse(json.replace(/\\(["[\]])/g, "$1")) as unknown
  }
}

const CODE_BLOCK_NODE_LINE_RE = /^(\s*)\\*<!--\s*adf:codeBlock(?:\s+node=([\s\S]*?))?\s*-->(\s*)$/
const CODE_BLOCK_END_LINE_RE = /^(\s*)\\*<!--\s*adf:\/codeBlock\s*-->(\s*)$/

const normalizePlaceholderLine = (line: string): string => {
  const codeBlock = CODE_BLOCK_NODE_LINE_RE.exec(line)
  if (codeBlock) {
    const [, indent, rawNode, trailing] = codeBlock
    const node = decodeNode(rawNode)
    return node?.type === "codeBlock"
      ? `${indent}<!-- adf:codeBlock node=${toBase64(JSON.stringify(node))} -->${trailing}`
      : line
  }

  const codeBlockEnd = CODE_BLOCK_END_LINE_RE.exec(line)
  if (codeBlockEnd) {
    const [, indent, trailing] = codeBlockEnd
    return `${indent}<!-- adf:/codeBlock -->${trailing}`
  }

  return line
}

export const normalizeAdfMetadataPlaceholders = (markdown: string): string =>
  markdown.split("\n").map(normalizePlaceholderLine).join("\n")

/** Split a text node into a sequence of text + status + inlineExtension nodes. */
const expandInlineText = (
  text: string,
  marks: ReadonlyArray<AdfNode> | undefined
): ReadonlyArray<AdfNode> => {
  // Reset lastIndex; sticky regexes are stateful across calls.
  const re = new RegExp(COMBINED_INLINE_RE.source, "g")
  const out: Array<AdfNode> = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push(textNode(text.slice(lastIndex, match.index), marks))
    }
    // Capture groups follow COMBINED_INLINE_RE order.
    // InlineNode: 1=type, 2=node. Status: 3=color, 4=text.
    // InlineCard: 5=attrs. InlineExtension: 6=key, 7=type, 8=attrs.
    // Underline: 9=text. Sub: 10=text. Sup: 11=text.
    // Text color: 12=color, 13=text. Background color: 14=color, 15=text.
    if (match[1] !== undefined) {
      const decoded = decodeNode(match[2])
      if (decoded && decoded.type === match[1]) out.push(decoded)
    } else if (match[3] !== undefined) {
      out.push({ type: "status", attrs: { text: match[4] ?? "", color: match[3] } })
    } else if (match[5] !== undefined) {
      out.push({ type: "inlineCard", attrs: buildInlineCardAttrs(match[5]) })
    } else if (match[9] !== undefined) {
      out.push(textNode(match[9], addMark(marks, { type: "underline" })))
    } else if (match[10] !== undefined) {
      out.push(textNode(match[10], addMark(marks, { type: "subsup", attrs: { type: "sub" } })))
    } else if (match[11] !== undefined) {
      out.push(textNode(match[11], addMark(marks, { type: "subsup", attrs: { type: "sup" } })))
    } else if (match[12] !== undefined) {
      out.push(textNode(match[13] ?? "", addMark(marks, { type: "textColor", attrs: { color: match[12] } })))
    } else if (match[14] !== undefined) {
      out.push(textNode(match[15] ?? "", addMark(marks, { type: "backgroundColor", attrs: { color: match[14] } })))
    } else {
      out.push({ type: "inlineExtension", attrs: buildExtensionAttrs(match[6], match[7], match[8]) })
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex === 0) return [textNode(text, marks)]
  if (lastIndex < text.length) out.push(textNode(text.slice(lastIndex), marks))
  return out
}

const MENTION_SCHEME = "confluence-mention://"

/**
 * If the text node carries a `confluence-mention://` link mark, return the
 * corresponding mention node — otherwise null.
 */
const tryParseMentionTextNode = (n: AdfNode): AdfNode | null => {
  if (!n.text || !n.marks) return null
  const link = n.marks.find((m) => m.type === "link")
  if (!link) return null
  const href = link.attrs?.["href"]
  if (typeof href !== "string" || !href.startsWith(MENTION_SCHEME)) return null
  let id: string
  try {
    id = decodeURIComponent(href.slice(MENTION_SCHEME.length))
  } catch {
    // Malformed encoding — leave the link alone rather than crashing the push.
    return null
  }
  return { type: "mention", attrs: { id, text: n.text } }
}

interface BlockExtensionMarker {
  readonly kind: "extension" | "bodiedExtension"
  readonly attrs: Record<string, unknown>
}

/**
 * If the paragraph's only content is a single text node holding a block-extension
 * comment, return the marker's kind and reconstructed attrs — otherwise null.
 */
const soleTextChild = (node: AdfNode): AdfNode | null => {
  if (node.type !== "paragraph") return null
  const content = node.content ?? []
  if (content.length !== 1) return null
  const child = content[0]
  if (!child || child.type !== "text" || !child.text || hasCodeMark(child)) return null
  return child
}

const parseBlockExtensionParagraph = (node: AdfNode): BlockExtensionMarker | null => {
  const child = soleTextChild(node)
  if (!child || !child.text) return null
  const match = BLOCK_EXTENSION_RE.exec(child.text)
  if (!match) return null
  const [, kind, key, type, attrsB64] = match
  return {
    kind: kind === "bodiedExtension" ? "bodiedExtension" : "extension",
    attrs: buildExtensionAttrs(key, type, attrsB64)
  }
}

const parseTocParagraph = (node: AdfNode): AdfNode | null => {
  const child = soleTextChild(node)
  if (!child || !child.text) return null
  const match = TOC_RE.exec(child.text)
  if (!match) return null

  let minLevel: string | undefined
  let maxLevel: string | undefined
  const params = match[1]?.trim()

  if (params && params.length > 0) {
    const seen = new Set<string>()
    for (const part of params.split(",")) {
      const [rawKey, rawValue, ...rest] = part.split("=")
      if (rest.length > 0) return null
      const key = rawKey?.trim()
      const value = rawValue?.trim()
      if ((key !== "min" && key !== "max") || !value || !/^[1-6]$/.test(value) || seen.has(key)) return null
      seen.add(key)
      if (key === "min") minLevel = value
      else maxLevel = value
    }
  } else if (params !== undefined) {
    return null
  }

  const macroParams: Record<string, { readonly value: string }> = {}
  if (minLevel) macroParams.minLevel = { value: minLevel }
  if (maxLevel) macroParams.maxLevel = { value: maxLevel }

  const attrs: Record<string, unknown> = {
    extensionKey: "toc",
    extensionType: CONFLUENCE_CORE_MACRO_TYPE
  }
  if (Object.keys(macroParams).length > 0) {
    attrs.parameters = { macroParams }
  }

  return { type: "extension", attrs }
}

const isBodiedExtensionEnd = (node: AdfNode): boolean => {
  const child = soleTextChild(node)
  return child !== null && typeof child.text === "string" && BODIED_EXTENSION_END_RE.test(child.text)
}

const parsePanelParagraph = (node: AdfNode): Record<string, unknown> | null => {
  const child = soleTextChild(node)
  if (!child || !child.text) return null
  const match = PANEL_RE.exec(child.text)
  if (!match) return null
  const [, type, attrsB64] = match
  return buildPanelAttrs(type, attrsB64)
}

const isPanelEnd = (node: AdfNode): boolean => {
  const child = soleTextChild(node)
  return child !== null && typeof child.text === "string" && PANEL_END_RE.test(child.text)
}

const parseEncodedBlockNodeParagraph = (node: AdfNode): { readonly type: string; readonly node: AdfNode } | null => {
  const child = soleTextChild(node)
  if (!child || !child.text) return null
  const match = ENCODED_BLOCK_NODE_RE.exec(child.text)
  if (!match) return null
  const decoded = decodeNode(match[2])
  if (!decoded || decoded.type !== match[1]) return null
  return { type: match[1]!, node: decoded }
}

const isEncodedBlockNodeEnd = (node: AdfNode, type: string): boolean => {
  const child = soleTextChild(node)
  if (child === null || typeof child.text !== "string") return false
  const match = ENCODED_BLOCK_NODE_END_RE.exec(child.text)
  return match?.[1] === type
}

const textContent = (node: AdfNode): string => node.text ?? (node.content ?? []).map(textContent).join("")

const isMeaningfulMarkerBodyNode = (node: AdfNode): boolean =>
  node.type === "paragraph" ? textContent(node).trim().length > 0 : true

const withoutSingleEmMark = (node: AdfNode): AdfNode => {
  if (node.type !== "text") return node.content ? { ...node, content: node.content.map(withoutSingleEmMark) } : node
  const marks = node.marks ?? []
  const nextMarks = marks.filter((mark) => mark.type !== "em")
  return nextMarks.length === 0 ? { type: "text", text: node.text ?? "" } : { ...node, marks: nextMarks }
}

const paragraphCaption = (body: ReadonlyArray<AdfNode>): AdfNode | null => {
  const meaningfulIndexes: Array<number> = []
  for (const [index, node] of body.entries()) {
    if (isMeaningfulMarkerBodyNode(node)) meaningfulIndexes.push(index)
  }

  let paragraph: { readonly node: AdfNode; readonly index: number } | null = null
  for (let index = body.length - 1; index >= 0; index--) {
    const node = body[index]
    if (node?.type === "paragraph" && textContent(node).trim().length > 0) {
      paragraph = { node, index }
      break
    }
  }
  if (paragraph === null) return null
  if (meaningfulIndexes.length === 1 && meaningfulIndexes[0] === paragraph.index) return null
  return {
    type: "caption",
    content: (paragraph.node.content ?? []).map(withoutSingleEmMark)
  }
}

const restoreMediaSingleNode = (node: AdfNode, body: ReadonlyArray<AdfNode>): AdfNode => {
  const mediaContent = (node.content ?? []).filter((child) => child.type !== "caption")
  const caption = paragraphCaption(body)
  return {
    ...node,
    content: caption ? [...mediaContent, caption] : mediaContent
  }
}

const parseParagraphMarksParagraph = (node: AdfNode): ReadonlyArray<AdfNode> | null => {
  const child = soleTextChild(node)
  if (!child || !child.text) return null
  const match = PARAGRAPH_MARKS_RE.exec(child.text)
  if (!match) return null
  return decodeMarks(match[1])
}

const isParagraphMarksEnd = (node: AdfNode): boolean => {
  const child = soleTextChild(node)
  return child !== null && typeof child.text === "string" && PARAGRAPH_MARKS_END_RE.test(child.text)
}

/**
 * Replace block-extension marker paragraphs among `children`. A bare
 * `extension` marker becomes an extension node; a `bodiedExtension` marker
 * swallows every sibling up to its `adf:/bodiedExtension` end marker as the
 * extension's body.
 *
 * Pairing rules, in order of defence:
 *  - the forward scan stops at the next bodied *open* marker, so an unpaired
 *    legacy/hand-edited open cannot steal a later macro's end marker and
 *    swallow unrelated content in between;
 *  - an open with no end marker is downgraded to a plain extension (macro
 *    identity and configuration kept, body left in place as siblings);
 *  - an open/end pair with nothing in between keeps its bodied kind via a
 *    stub empty paragraph (the schema requires non-empty content);
 *  - parents whose content model forbids bodiedExtension (blockquote,
 *    listItem, …) get the downgrade too, or outgoing validation would fail;
 *  - stray end markers are dropped — they are this module's own syntax,
 *    never user content.
 */
const groupBlockExtensions = (children: ReadonlyArray<AdfNode>, parentType: string): ReadonlyArray<AdfNode> => {
  const allowBodied = BODIED_EXTENSION_PARENTS.has(parentType)
  const out: Array<AdfNode> = []
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (!child) continue
    const marker = parseBlockExtensionParagraph(child)
    if (!marker) {
      if (!isBodiedExtensionEnd(child)) out.push(child)
      continue
    }
    if (marker.kind === "extension") {
      out.push({ type: "extension", attrs: marker.attrs })
      continue
    }
    let end = -1
    for (let j = i + 1; j < children.length; j++) {
      if (isBodiedExtensionEnd(children[j]!)) {
        end = j
        break
      }
      if (parseBlockExtensionParagraph(children[j]!)?.kind === "bodiedExtension") break
    }
    if (end === -1 || !allowBodied) {
      out.push({ type: "extension", attrs: marker.attrs })
      continue
    }
    // Group recursively so an extension marker *inside* the body (a macro
    // nested in a bodied macro) is also reverted, not left as literal text.
    const body = groupBlockExtensions(children.slice(i + 1, end), "bodiedExtension")
    out.push({
      type: "bodiedExtension",
      attrs: marker.attrs,
      content: body.length > 0 ? body : [{ type: "paragraph", content: [] }]
    })
    i = end
  }
  return out
}

const groupPanels = (children: ReadonlyArray<AdfNode>): ReadonlyArray<AdfNode> => {
  const out: Array<AdfNode> = []
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (!child) continue
    const attrs = parsePanelParagraph(child)
    if (!attrs) {
      if (!isPanelEnd(child)) out.push(child)
      continue
    }

    let end = -1
    for (let j = i + 1; j < children.length; j++) {
      if (isPanelEnd(children[j]!)) {
        end = j
        break
      }
      if (parsePanelParagraph(children[j]!)) break
    }

    if (end === -1) {
      out.push({ type: "panel", attrs, content: [{ type: "paragraph", content: [] }] })
      continue
    }

    const body = groupPanels(children.slice(i + 1, end))
    out.push({
      type: "panel",
      attrs,
      content: body.length > 0 ? body : [{ type: "paragraph", content: [] }]
    })
    i = end
  }
  return out
}

const groupEncodedBlockNodes = (children: ReadonlyArray<AdfNode>): ReadonlyArray<AdfNode> => {
  const out: Array<AdfNode> = []
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (!child) continue
    const marker = parseEncodedBlockNodeParagraph(child)
    if (!marker) {
      out.push(child)
      continue
    }

    let end = -1
    for (let j = i + 1; j < children.length; j++) {
      if (isEncodedBlockNodeEnd(children[j]!, marker.type)) {
        end = j
        break
      }
      if (parseEncodedBlockNodeParagraph(children[j]!) !== null) break
    }

    out.push(
      marker.type === "mediaSingle" && end !== -1
        ? restoreMediaSingleNode(marker.node, children.slice(i + 1, end))
        : marker.node
    )
    if (end !== -1) i = end
  }
  return out
}

const groupMarkedParagraphs = (children: ReadonlyArray<AdfNode>): ReadonlyArray<AdfNode> => {
  const out: Array<AdfNode> = []
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (!child) continue
    const marks = parseParagraphMarksParagraph(child)
    if (!marks) {
      if (!isParagraphMarksEnd(child)) out.push(child)
      continue
    }

    let end = -1
    for (let j = i + 1; j < children.length; j++) {
      if (isParagraphMarksEnd(children[j]!)) {
        end = j
        break
      }
      if (parseParagraphMarksParagraph(children[j]!) !== null) break
    }

    if (end === -1) {
      out.push({ type: "paragraph", marks, content: [] })
      continue
    }

    const body = children.slice(i + 1, end)
    const first = body[0]
    if (first?.type === "paragraph") {
      out.push(marks.length > 0 ? { ...first, marks } : first)
      for (const rest of body.slice(1)) out.push(rest)
    } else {
      out.push({ type: "paragraph", marks, content: [] })
      for (const rest of body) out.push(rest)
    }
    i = end
  }
  return out
}

const groupNativeMacros = (children: ReadonlyArray<AdfNode>): ReadonlyArray<AdfNode> =>
  children.map((child) => parseTocParagraph(child) ?? child)

const transform = (node: AdfNode): AdfNode => {
  // ADF codeBlock permits only plain text children — expanding placeholder-
  // looking text inside one would inject schema-invalid nodes and corrupt
  // code samples that merely *quote* the placeholder syntax.
  if (node.type === "codeBlock") return node
  if (!node.content) return node

  const newContent: Array<AdfNode> = []
  for (const child of node.content) {
    if (child.type === "text" && child.text && !hasCodeMark(child)) {
      const mention = tryParseMentionTextNode(child)
      if (mention) {
        newContent.push(mention)
      } else {
        for (const piece of expandInlineText(child.text, child.marks)) {
          newContent.push(piece)
        }
      }
    } else {
      newContent.push(transform(child))
    }
  }
  const nativeMacrosRestored = groupNativeMacros(newContent)
  const paragraphsRestored = groupMarkedParagraphs(nativeMacrosRestored)
  const encodedBlocksRestored = groupEncodedBlockNodes(paragraphsRestored)
  return { ...node, content: groupPanels(groupBlockExtensions(encodedBlocksRestored, node.type)) }
}

/** Walk the document tree and rewrite placeholder text into proper ADF nodes. */
export const revertPlaceholders = (doc: unknown): unknown => transform(doc as AdfNode)
