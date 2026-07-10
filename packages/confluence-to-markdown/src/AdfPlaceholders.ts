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

export interface AdfNode {
  readonly type: string
  readonly attrs?: Record<string, unknown>
  readonly content?: ReadonlyArray<AdfNode>
  readonly text?: string
  readonly marks?: ReadonlyArray<AdfNode>
}

const isRecord = (value: unknown): value is Readonly<Record<PropertyKey, unknown>> =>
  typeof value === "object" && value !== null

const isAdfNode = (value: unknown): value is AdfNode => isRecord(value) && typeof value.type === "string"

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
    const parsed = parsePlaceholderJson(raw.startsWith("{") ? raw : fromBase64(raw))
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
    const parsed = parsePlaceholderJson(raw.startsWith("[") ? raw : fromBase64(raw))
    return Array.isArray(parsed) ? parsed.filter(isAdfNode) : []
  } catch {
    return []
  }
}

const decodeNode = (b64: string | undefined): AdfNode | null => {
  if (!b64) return null
  try {
    const raw = b64.trim()
    const parsed = parsePlaceholderJson(raw.startsWith("{") ? raw : fromBase64(raw))
    return isAdfNode(parsed) ? parsed : null
  } catch {
    return null
  }
}

const parsePlaceholderJson = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    // @atlaskit's markdown parser may insert markdown escapes into placeholder
    // text before we restore it. Square brackets are common inside code-block
    // JSON samples and `\[` / `\]` are invalid JSON escapes.
    return JSON.parse(json.replace(/\\(["[\]])/g, "$1"))
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

const isTableRow = (node: AdfNode): boolean => node.type === "tableRow"
const isTableCell = (node: AdfNode): boolean => node.type === "tableCell" || node.type === "tableHeader"

const attrNumber = (attrs: Record<string, unknown> | undefined, key: string): number | null => {
  const value = attrs?.[key]
  return typeof value === "number" ? value : null
}

// A merged cell spans more than one grid column/row, so the flat GFM grid the
// user edits can't be aligned to it by index — the counts won't line up. When
// the sidecar table carries any, we can't safely reconcile and bail to it.
const hasMergedCell = (cell: AdfNode): boolean => {
  const colspan = attrNumber(cell.attrs, "colspan")
  const rowspan = attrNumber(cell.attrs, "rowspan")
  return (colspan !== null && colspan > 1) || (rowspan !== null && rowspan > 1)
}

// A cell body only survives the GFM round-trip when it is at most one
// paragraph of round-trippable inline content. Anything richer (multiple
// blocks, lists, code blocks, …) was flattened into <br>-joined Markdown on
// pull; hardBreaks are emitted as literal `<br>` and parse back as plain
// text; boundary whitespace is trimmed by the GFM cell delimiters. In all of
// those cases the GFM-parsed cell is a degraded copy of the sidecar body —
// even on an unchanged push.
// Hrefs containing these are rewritten on the way out — table-cell pipe
// escaping parses back as %7C, and safeHref percent-encodes `<`/`>`/`\` (and
// wraps for spaces, which are unverified in angle-bracket destinations) — so
// they parse back changed. Balanced parens survive inside the wrapper.
const LOSSY_HREF_RE = /[| <>\\]/

// Marks emitted as HTML span placeholders: their reverter regexes match the
// span body with `[^<]*`, so a literal `<` in the marked text breaks
// rehydration and the push degrades to literal HTML.
const HTML_SPAN_MARKS = new Set(["underline", "subsup", "textColor", "backgroundColor"])

// Whether an inline node survives the GFM round-trip inside a table cell.
// Plain text round-trips — the parser unescapes what the walker escaped,
// including inside span placeholder bodies and mention link labels (verified
// empirically). Date, emoji and inlineExtension are full-fidelity base64
// placeholders; status/mention/inlineCard survive their narrower encodings
// except where noted. Anything else (mediaInline, placeholder, …) is emitted
// as a comment this module does not expand, so the GFM copy degrades to text.
const inlineRoundTrips = (node: AdfNode): boolean => {
  switch (node.type) {
    case "text":
      return (node.marks ?? []).every((mark) => {
        if (mark.type === "link") {
          const href = mark.attrs?.["href"]
          return typeof href === "string" && !LOSSY_HREF_RE.test(href)
        }
        if (HTML_SPAN_MARKS.has(mark.type)) return !(node.text ?? "").includes("<")
        return true
      })
    case "status": {
      // STATUS_RE's body can't cross a literal `<`.
      const text = node.attrs?.["text"]
      return typeof text !== "string" || !text.includes("<")
    }
    case "mention": {
      const id = node.attrs?.["id"]
      const text = node.attrs?.["text"]
      return typeof id === "string" && id.length > 0 && typeof text === "string" && text.startsWith("@")
    }
    case "inlineCard": {
      const attrs = node.attrs ?? {}
      const data = attrs["data"]
      const url = attrs["url"] ?? (isRecord(data) ? data["url"] : undefined)
      return typeof url === "string" && url.length > 0
    }
    case "date":
    case "emoji":
    case "inlineExtension":
      return true
    default:
      return false
  }
}

const cellBodyFlattenedOnPull = (cell: AdfNode): boolean => {
  const blocks = cell.content ?? []
  if (blocks.length > 1) return true
  const only = blocks[0]
  if (only === undefined) return false
  if (only.type !== "paragraph") return true
  const inline = only.content ?? []
  if (inline.some((node) => !inlineRoundTrips(node))) return true
  const first = inline[0]
  if (first?.type === "text" && first.text !== undefined && first.text !== first.text.trimStart()) return true
  const last = inline[inline.length - 1]
  return last?.type === "text" && last.text !== undefined && last.text !== last.text.trimEnd()
}

// Keep the sidecar cell's identity (tableHeader vs tableCell) and its attrs
// (colwidth, background, localId, …); take only the freshly edited body from
// the GFM-parsed cell — that content is what the human typed in the markdown.
// Cells whose body was flattened on pull keep the authoritative sidecar body
// instead (edits to them are documented-lossy, like merged-cell tables).
const mergeTableCell = (sidecarCell: AdfNode, gfmCell: AdfNode): AdfNode => {
  if (cellBodyFlattenedOnPull(sidecarCell)) return sidecarCell
  // Identical projected fingerprints mean nothing Markdown-visible changed —
  // keep the sidecar body wholesale so attrs the Markdown can't express
  // (status localId/style, link titles, …) survive a no-op push.
  if (cellText(sidecarCell) === cellText(gfmCell)) return sidecarCell
  const gfmContent = gfmCell.content ?? []
  const sidecarPara = (sidecarCell.content ?? [])[0]
  const gfmPara = gfmContent.length === 1 && gfmContent[0]!.type === "paragraph" ? gfmContent[0]! : null
  // Paragraph-level attrs/marks (localId, alignment, …) aren't expressible in
  // a GFM cell; graft them back on when the shape still lines up.
  const content = sidecarPara && gfmPara && (sidecarPara.attrs !== undefined || sidecarPara.marks !== undefined)
    ? [{
      ...gfmPara,
      ...(sidecarPara.attrs !== undefined ? { attrs: sidecarPara.attrs } : {}),
      ...(sidecarPara.marks !== undefined ? { marks: sidecarPara.marks } : {})
    }]
    : gfmContent
  return sidecarCell.attrs
    ? { type: sidecarCell.type, attrs: sidecarCell.attrs, content }
    : { type: sidecarCell.type, content }
}

// Content fingerprint used to verify index alignment. Both sides are ADF
// (the sidecar node and the GFM-parsed node), so the serialization is
// comparable; anything that doesn't round-trip identically simply won't
// match, which errs on the safe side (bail to the sidecar). Marks are folded
// in so `foo` and `**foo**` stay distinct, and leaves without text or
// children (status, date, emoji, …) serialize their attrs so distinct leaves
// don't all collapse to the empty string — either collapse would make moved
// content look unchanged and glue attrs to the wrong position.
// Attrs are projected down to what the walker's Markdown emission actually
// encodes — a status keeps only text/color, a mention only id/text, a link
// mark only href. That way a sidecar node carrying extra attrs the Markdown
// can't express (localId, style, title, …) still fingerprint-matches its GFM
// round-trip, letting the merge recognise "unchanged" and keep the richer
// sidecar body instead of adopting the stripped GFM copy.
const PROJECTED_NODE_ATTRS: Record<string, ReadonlyArray<string>> = {
  status: ["color", "text"],
  mention: ["id", "text"]
}
const PROJECTED_MARK_ATTRS: Record<string, ReadonlyArray<string>> = {
  link: ["href"]
}

const projectAttrs = (
  attrs: Record<string, unknown>,
  keys: ReadonlyArray<string> | undefined
): Record<string, unknown> => {
  if (keys === undefined) return attrs
  const out: Record<string, unknown> = {}
  for (const key of keys) if (key in attrs) out[key] = attrs[key]
  return out
}

const attrsFingerprint = (attrs: Record<string, unknown>): string =>
  Object.keys(attrs).sort().map((key) => `${key}=${JSON.stringify(attrs[key])}`).join(" ")

const markFingerprint = (mark: AdfNode): string => {
  const attrs = mark.attrs === undefined ? undefined : projectAttrs(mark.attrs, PROJECTED_MARK_ATTRS[mark.type])
  return attrs === undefined || Object.keys(attrs).length === 0
    ? mark.type
    : `${mark.type}(${attrsFingerprint(attrs)})`
}

const nodeText = (node: AdfNode): string => {
  const children = node.content ?? []
  const marks = node.marks ?? []
  const wrap = (body: string): string =>
    marks.length === 0 ? body : `[${marks.map(markFingerprint).sort().join(",")}](${body})`
  if (node.text !== undefined || children.length > 0) {
    return wrap((node.text ?? "") + children.map(nodeText).join(""))
  }
  const attrs = node.attrs === undefined ? undefined : projectAttrs(node.attrs, PROJECTED_NODE_ATTRS[node.type])
  if (attrs === undefined || Object.keys(attrs).length === 0) return wrap(`<${node.type}>`)
  return wrap(`<${node.type} ${attrsFingerprint(attrs)}>`)
}

const cellText = (cell: AdfNode): string => nodeText(cell).trim()

// NUL can't appear in ADF text, so joins can't collide across cells.
const FP_SEP = "\u0000"

const rowFingerprint = (row: AdfNode): string => (row.content ?? []).map(cellText).join(FP_SEP)

const columnFingerprint = (rows: ReadonlyArray<AdfNode>, col: number): string =>
  rows.map((row) => cellText((row.content ?? [])[col] ?? { type: "tableCell" })).join(FP_SEP)

/**
 * Decide, for every GFM item (row or column), which sidecar item supplies its
 * attrs — `null` marks a freshly inserted item. Works on plain-text
 * fingerprints, so it can only reason about what survives the GFM round trip;
 * every ambiguous case returns null (= fall back to the sidecar). Supported
 * shapes:
 *  - equal length, same text per position: identity (a no-op or attr-only
 *    sidecar difference)
 *  - equal length with in-place edits: positions correspond one-to-one
 *  - equal length pure reorder: every changed item's text is found at exactly
 *    one other position, so attrs travel with the moved content; a mix of
 *    moved and edited items is refused
 *  - one clean contiguous inserted/deleted block anywhere (no edits): the
 *    matched prefix and suffix meet exactly
 *  - edits combined with a tail insert/delete: the overlap pairs by index —
 *    guarded by refusing when a mismatched sidecar item reappears later in
 *    the GFM (the signature of a mid-sequence shift) or when the surplus
 *    items duplicate existing text (indistinguishable from a shifted
 *    duplicate)
 */
const alignByFingerprint = (
  sidecar: ReadonlyArray<string>,
  gfm: ReadonlyArray<string>
): Array<number | null> | null => {
  const n = sidecar.length
  const m = gfm.length
  if (n === m) {
    const map: Array<number | null> = gfm.map((fp, i) => (fp === sidecar[i] ? i : null))
    if (!map.includes(null)) return map
    // Try to recognise moved content among the changed positions: a moved
    // item keeps its text, an edited item keeps its position. Counts are
    // global — a duplicate that stayed anchored in place still makes its
    // moved twin ambiguous (either copy could be the one that moved).
    const count = (fps: ReadonlyArray<string>): Map<string, number> => {
      const totals = new Map<string, number>()
      for (const fp of fps) totals.set(fp, (totals.get(fp) ?? 0) + 1)
      return totals
    }
    const sidecarCount = count(sidecar)
    const gfmCount = count(gfm)
    const changedSidecar = new Map<string, number>()
    for (let j = 0; j < n; j++) {
      if (gfm[j] !== sidecar[j]) changedSidecar.set(sidecar[j]!, j)
    }
    let moved = 0
    let edited = 0
    for (let i = 0; i < m; i++) {
      if (map[i] !== null) continue
      const source = changedSidecar.get(gfm[i]!)
      if (source === undefined) {
        edited++
        continue
      }
      // The moved text must be unique in BOTH tables, or several assignments
      // fit and each distributes attrs differently.
      if (sidecarCount.get(gfm[i]!) !== 1 || gfmCount.get(gfm[i]!) !== 1) return null
      map[i] = source
      moved++
    }
    // Every changed position is an in-place edit — identity.
    if (moved === 0) return gfm.map((_, i) => i)
    // Moves mixed with edits: an edited row is indistinguishable from a moved
    // row that was also edited, so the alignment is ambiguous.
    if (edited > 0) return null
    return map
  }
  const shared = Math.min(n, m)
  let prefix = 0
  while (prefix < shared && gfm[prefix] === sidecar[prefix]) prefix++
  let suffix = 0
  while (suffix < shared && gfm[m - 1 - suffix] === sidecar[n - 1 - suffix]) suffix++
  // Prefix and suffix overlap: duplicates surround the change, several
  // alignments fit, and each assigns attrs differently — refuse to guess.
  if (prefix + suffix > shared) return null
  if (prefix + suffix === shared) {
    // One clean inserted/deleted block between the matched prefix and suffix.
    return m > n
      ? gfm.map((_, i) => (i < prefix ? i : i < m - suffix ? null : i - (m - n)))
      : gfm.map((_, i) => (i < prefix ? i : i + (n - m)))
  }
  // Mismatches beyond a single block mean edits: pair the overlap by index
  // and treat the surplus as a tail insert/delete — unless something looks
  // shifted instead of edited.
  if (m > n) {
    for (let i = 0; i < n; i++) {
      if (gfm[i] !== sidecar[i] && gfm.indexOf(sidecar[i]!, i + 1) !== -1) return null
    }
    for (const fp of gfm.slice(n)) if (sidecar.includes(fp)) return null
    return gfm.map((_, i) => (i < n ? i : null))
  }
  for (let i = 0; i < m; i++) {
    if (gfm[i] !== sidecar[i] && sidecar.indexOf(gfm[i]!, i + 1) !== -1) return null
  }
  for (const fp of sidecar.slice(m)) if (gfm.includes(fp)) return null
  return gfm.map((_, i) => i)
}

// A header column exists in ADF (every row's cell in that column is a
// tableHeader) but GFM can only mark the first *row* as headers, so a row
// inserted in Markdown parses its header-column cells as plain tableCell —
// restore the column's identity from the sidecar. Only the sidecar's *body*
// rows can testify to a header column: the header row is tableHeader across
// every column, so a header-only table would otherwise turn a freshly added
// data row into another header row.
const restoreHeaderColumnCells = (
  gfmRow: AdfNode,
  sidecarRows: ReadonlyArray<AdfNode>,
  colMap: ReadonlyArray<number | null>
): AdfNode => {
  const first = sidecarRows[0]
  const bodyRows = first !== undefined && isAllHeaderRow(first) ? sidecarRows.slice(1) : sidecarRows
  if (bodyRows.length === 0) return gfmRow
  const cells = (gfmRow.content ?? []).map((cell, c) => {
    const sc = colMap[c]
    if (sc === null || sc === undefined || cell.type !== "tableCell") return cell
    const isHeaderColumn = bodyRows.every((row) => (row.content ?? [])[sc]?.type === "tableHeader")
    return isHeaderColumn ? { ...cell, type: "tableHeader" } : cell
  })
  return { ...gfmRow, content: cells }
}

const mergeTableRow = (
  sidecarRow: AdfNode,
  gfmRow: AdfNode,
  colMap: ReadonlyArray<number | null>
): AdfNode | null => {
  const sidecarCells = sidecarRow.content ?? []
  const gfmCells = gfmRow.content ?? []
  const cells: Array<AdfNode> = []
  for (let c = 0; c < gfmCells.length; c++) {
    const gfmCell = gfmCells[c]!
    if (!isTableCell(gfmCell)) return null
    const sc = colMap[c]
    const sidecarCell = sc !== null && sc !== undefined ? sidecarCells[sc] : undefined
    // Columns present in the sidecar keep its attrs; a column added in the GFM
    // has no counterpart, so its parsed cell is used verbatim.
    cells.push(sidecarCell && isTableCell(sidecarCell) ? mergeTableCell(sidecarCell, gfmCell) : gfmCell)
  }
  return sidecarRow.attrs
    ? { type: "tableRow", attrs: sidecarRow.attrs, content: cells }
    : { type: "tableRow", content: cells }
}

const isAllHeaderRow = (row: AdfNode): boolean => {
  const cells = row.content ?? []
  return cells.length > 0 && cells.every((cell) => cell.type === "tableHeader")
}

const isEmptyCellBody = (cell: AdfNode): boolean =>
  (cell.content ?? []).every((block) => block.type === "paragraph" && (block.content ?? []).length === 0)

/**
 * Merge the GFM-parsed table (the user's editable content) over the sidecar
 * table node (the authoritative attrs). Cell text comes from the GFM table;
 * table/row/cell attrs and header-vs-cell identity come from the sidecar,
 * aligned via `alignByFingerprint` on both axes — cell edits merge freely
 * when the shape is unchanged, and row/column inserts or deletions merge when
 * the alignment is unambiguous. A headerless sidecar table was emitted with a
 * synthetic empty GFM header row (Markdown tables require one) that has no
 * sidecar counterpart — it is dropped before aligning. Returns null —
 * signalling "fall back to the sidecar node unchanged" — when the shapes
 * can't be reconciled: merged cells or a ragged (non-rectangular) grid in
 * the sidecar (the walker pads those rows, so a positional merge would mutate
 * them on a no-op push), text typed into the synthetic header row, rows and
 * columns changed in the same push, an ambiguous alignment, or a missing GFM
 * table. That keeps a push from silently corrupting a table it can't edit.
 */
const mergeTableWithGfm = (sidecar: AdfNode, gfm: AdfNode): AdfNode | null => {
  if (sidecar.type !== "table" || gfm.type !== "table") return null
  const sidecarRows = sidecar.content ?? []
  let gfmRows = gfm.content ?? []
  if (gfmRows.length === 0 || sidecarRows.length === 0) return null
  if (!sidecarRows.every(isTableRow) || !gfmRows.every(isTableRow)) return null
  for (const row of sidecarRows) {
    for (const cell of row.content ?? []) {
      if (hasMergedCell(cell)) return null
    }
  }
  const width = (row: AdfNode): number => (row.content ?? []).length
  const sidecarWidth = width(sidecarRows[0]!)
  const gfmWidth = width(gfmRows[0]!)
  if (!sidecarRows.every((row) => width(row) === sidecarWidth)) return null
  if (!gfmRows.every((row) => width(row) === gfmWidth)) return null
  const sidecarFirst = sidecarRows[0]!
  if (!isAllHeaderRow(sidecarFirst)) {
    const gfmFirst = gfmRows[0]!
    if (!isAllHeaderRow(gfmFirst) || !(gfmFirst.content ?? []).every(isEmptyCellBody)) return null
    gfmRows = gfmRows.slice(1)
    if (gfmRows.length === 0) return null
  }
  // Changing rows and columns in the same push leaves no reliable axis to
  // fingerprint against — one change at a time.
  if (gfmRows.length !== sidecarRows.length && gfmWidth !== sidecarWidth) return null
  // A cell flattened on pull can never fingerprint-match its GFM copy, so
  // under a structural change the alignment would misattribute its row or
  // column (e.g. an inserted row maps onto the lossy row, whose sidecar-
  // authoritative body then swallows the inserted content). Cell edits on
  // the unchanged shape still work; structural changes fall back.
  if (gfmRows.length !== sidecarRows.length || gfmWidth !== sidecarWidth) {
    for (const row of sidecarRows) {
      for (const cell of row.content ?? []) {
        if (cellBodyFlattenedOnPull(cell)) return null
      }
    }
  }
  // Each axis' identity must be judged on the parts of the other axis that
  // both tables share — a resized or reordered other-axis folded into the
  // fingerprints would make every item mismatch and a simultaneous reorder
  // masquerade as harmless in-place edits, gluing attrs to old positions.
  // When the widths differ the row counts are equal, so columns are aligned
  // first (over all rows) and rows are then judged on the shared columns;
  // otherwise rows are aligned first and columns judged on the shared rows.
  let rowMap: Array<number | null>
  let colMap: Array<number | null>
  if (gfmWidth === sidecarWidth) {
    const rows = alignByFingerprint(sidecarRows.map(rowFingerprint), gfmRows.map(rowFingerprint))
    if (rows === null) return null
    rowMap = rows
    const alignedSidecarRows: Array<AdfNode> = []
    const alignedGfmRows: Array<AdfNode> = []
    for (let r = 0; r < gfmRows.length; r++) {
      const sr = rowMap[r]
      if (sr === null || sr === undefined) continue
      alignedSidecarRows.push(sidecarRows[sr]!)
      alignedGfmRows.push(gfmRows[r]!)
    }
    if (alignedSidecarRows.length === 0) return null
    const cols = alignByFingerprint(
      Array.from({ length: sidecarWidth }, (_, col) => columnFingerprint(alignedSidecarRows, col)),
      Array.from({ length: gfmWidth }, (_, col) => columnFingerprint(alignedGfmRows, col))
    )
    if (cols === null) return null
    colMap = cols
  } else {
    const cols = alignByFingerprint(
      Array.from({ length: sidecarWidth }, (_, col) => columnFingerprint(sidecarRows, col)),
      Array.from({ length: gfmWidth }, (_, col) => columnFingerprint(gfmRows, col))
    )
    if (cols === null) return null
    colMap = cols
    const sharedSidecarCols: Array<number> = []
    const sharedGfmCols: Array<number> = []
    for (let c = 0; c < colMap.length; c++) {
      const sc = colMap[c]
      if (sc === null || sc === undefined) continue
      sharedSidecarCols.push(sc)
      sharedGfmCols.push(c)
    }
    if (sharedSidecarCols.length === 0) return null
    const rowOverCols = (row: AdfNode, cols_: ReadonlyArray<number>): string =>
      cols_.map((c) => cellText((row.content ?? [])[c] ?? { type: "tableCell" })).join(FP_SEP)
    const rows = alignByFingerprint(
      sidecarRows.map((row) => rowOverCols(row, sharedSidecarCols)),
      gfmRows.map((row) => rowOverCols(row, sharedGfmCols))
    )
    if (rows === null) return null
    rowMap = rows
  }
  // Reordering both axes at once is invisible to per-axis fingerprints (every
  // row fp embeds the old column order and vice versa), so both maps
  // degenerate to identity and attrs would stay at their old coordinates. Its
  // signature: a mismatched cell whose text is still found at a *vacated*
  // sidecar position — one whose own text is gone from its mapped spot — is
  // moved content, while an edit that merely copies a value that still sits
  // matched at its source is a genuine edit. Two or more moved-looking cells
  // mean a reorder the maps didn't capture — refuse to guess. (Runs over the
  // mapped overlap, so it also catches a reorder smuggled in alongside a
  // row/column insert or delete.)
  {
    const cellAt = (rows: ReadonlyArray<AdfNode>, r: number, c: number): string =>
      cellText((rows[r]!.content ?? [])[c] ?? { type: "tableCell" })
    const vacatedTexts = new Set<string>()
    const mismatchedGfmTexts: Array<string> = []
    for (let r = 0; r < gfmRows.length; r++) {
      for (let c = 0; c < gfmWidth; c++) {
        const sr = rowMap[r]
        const sc = colMap[c]
        if (sr === null || sr === undefined || sc === null || sc === undefined) continue
        const gfmText = cellAt(gfmRows, r, c)
        const sidecarText = cellAt(sidecarRows, sr, sc)
        if (gfmText === sidecarText) continue
        vacatedTexts.add(sidecarText)
        mismatchedGfmTexts.push(gfmText)
      }
    }
    let moved = 0
    for (const text of mismatchedGfmTexts) {
      // A blanked cell matches other blank cells without being "moved".
      const blank = text === "" || text === "<paragraph>" || text === "<tableCell>"
      if (!blank && vacatedTexts.has(text)) moved++
    }
    if (moved >= 2) return null
  }

  const rows: Array<AdfNode> = []
  for (let r = 0; r < gfmRows.length; r++) {
    const gfmRow = gfmRows[r]!
    const sr = rowMap[r]
    const sidecarRow = sr !== null && sr !== undefined ? sidecarRows[sr] : undefined
    if (!sidecarRow) {
      // A row inserted in the GFM has no sidecar counterpart — use its cells
      // verbatim, except that header-column cells regain their identity.
      rows.push(restoreHeaderColumnCells(gfmRow, sidecarRows, colMap))
      continue
    }
    const merged = mergeTableRow(sidecarRow, gfmRow, colMap)
    if (merged === null) return null
    rows.push(merged)
  }
  return { ...sidecar, content: rows }
}

const resolveEncodedBlockNode = (
  marker: { readonly type: string; readonly node: AdfNode },
  body: ReadonlyArray<AdfNode>
): AdfNode => {
  if (marker.type === "mediaSingle") return restoreMediaSingleNode(marker.node, body)
  if (marker.type === "table") {
    // The walker emits exactly one table between the markers. Anything else —
    // e.g. a blank line splitting the GFM table into two fragments — means
    // part of the editable content would be silently dropped if the first
    // fragment were merged; fall back to the sidecar node instead.
    const gfm = body.length === 1 && body[0]!.type === "table" ? body[0]! : null
    const merged = gfm ? mergeTableWithGfm(marker.node, gfm) : null
    if (merged) return merged
  }
  return marker.node
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

    out.push(end === -1 ? marker.node : resolveEncodedBlockNode(marker, children.slice(i + 1, end)))
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
export const revertPlaceholders = (doc: unknown): AdfNode => {
  if (!isAdfNode(doc)) {
    throw new TypeError("ADF document must be an object with a string type")
  }
  return transform(doc)
}
