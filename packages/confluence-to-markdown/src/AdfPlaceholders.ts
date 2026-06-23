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
 *  - `<!-- adf:bodiedExtension … --> BODY <!-- adf:/bodiedExtension -->`
 *      (the sibling blocks between the markers become the extension's body)
 *  - `<!-- adf:inlineExtension key=KEY type=TYPE attrs=BASE64 -->` (inline)
 *  - `[@Name](confluence-mention://ACCOUNT_ID)`            (link mark with a
 *      custom scheme — the only way to round-trip mention accountIds)
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
const INLINE_EXTENSION_RE =
  /<!--\s*adf:inlineExtension(?:\s+key=(\S+?))?(?:\s+type=(\S+?))?(?:\s+attrs=([A-Za-z0-9+/=]+))?\s*-->/g
const COMBINED_INLINE_RE = new RegExp(`${STATUS_RE.source}|${INLINE_EXTENSION_RE.source}`, "g")

const BLOCK_EXTENSION_RE =
  /^\s*<!--\s*adf:(extension|bodiedExtension)(?:\s+key=(\S+?))?(?:\s+type=(\S+?))?(?:\s+attrs=([A-Za-z0-9+/=]+))?\s*-->\s*$/
const BODIED_EXTENSION_END_RE = /^\s*<!--\s*adf:\/bodiedExtension\s*-->\s*$/

const textNode = (text: string, marks: ReadonlyArray<AdfNode> | undefined): AdfNode =>
  marks && marks.length > 0 ? { type: "text", text, marks } : { type: "text", text }

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

// JSON string → free-form attrs record; rejects null/arrays/primitives.
const AttrsBlob = Schema.Record(Schema.String, Schema.Unknown)
const decodeAttrsBlob = Schema.decodeUnknownOption(AttrsBlob)

const decodeAttrs = (b64: string | undefined): Record<string, unknown> | null => {
  if (!b64) return null
  try {
    const decoded = decodeAttrsBlob(JSON.parse(fromBase64(b64)) as unknown)
    return Option.isSome(decoded) ? decoded.value : null
  } catch {
    // Invalid base64 (hand-edited file?) — fall back to the readable key/type.
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
    // Status capture groups: 1=color, 2=text. InlineExtension: 3=key, 4=type, 5=attrs.
    if (match[1] !== undefined) {
      out.push({ type: "status", attrs: { text: match[2] ?? "", color: match[1] } })
    } else {
      out.push({ type: "inlineExtension", attrs: buildExtensionAttrs(match[3], match[4], match[5]) })
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

const isBodiedExtensionEnd = (node: AdfNode): boolean => {
  const child = soleTextChild(node)
  return child !== null && typeof child.text === "string" && BODIED_EXTENSION_END_RE.test(child.text)
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
  return { ...node, content: groupBlockExtensions(newContent, node.type) }
}

/** Walk the document tree and rewrite placeholder text into proper ADF nodes. */
export const revertPlaceholders = (doc: unknown): unknown => transform(doc as AdfNode)
