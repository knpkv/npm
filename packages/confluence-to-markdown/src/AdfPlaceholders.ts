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
 *  - `<!-- adf:extension key=KEY type=TYPE -->`            (block, when the
 *      whole paragraph is just this comment)
 *  - `<!-- adf:inlineExtension key=KEY type=TYPE -->`      (inline)
 *  - `[@Name](confluence-mention://ACCOUNT_ID)`            (link mark with a
 *      custom scheme — the only way to round-trip mention accountIds)
 *
 * @module
 */

interface AdfNode {
  readonly type: string
  readonly attrs?: Record<string, unknown>
  readonly content?: ReadonlyArray<AdfNode>
  readonly text?: string
  readonly marks?: ReadonlyArray<AdfNode>
}

const STATUS_RE = /<span class="adf-status"\s+data-color="([^"]+)">([^<]*)<\/span>/g
const INLINE_EXTENSION_RE = /<!--\s*adf:inlineExtension(?:\s+key=(\S+?))?(?:\s+type=(\S+?))?\s*-->/g
const COMBINED_INLINE_RE = new RegExp(`${STATUS_RE.source}|${INLINE_EXTENSION_RE.source}`, "g")

const BLOCK_EXTENSION_RE = /^\s*<!--\s*adf:(extension|bodiedExtension)(?:\s+key=(\S+?))?(?:\s+type=(\S+?))?\s*-->\s*$/

const textNode = (text: string, marks: ReadonlyArray<AdfNode> | undefined): AdfNode =>
  marks && marks.length > 0 ? { type: "text", text, marks } : { type: "text", text }

const buildExtensionAttrs = (key: string | undefined, type: string | undefined): Record<string, unknown> => {
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
    // Status capture groups: 1=color, 2=text. InlineExtension: 3=key, 4=type.
    if (match[1] !== undefined) {
      out.push({ type: "status", attrs: { text: match[2] ?? "", color: match[1] } })
    } else {
      out.push({ type: "inlineExtension", attrs: buildExtensionAttrs(match[3], match[4]) })
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

/**
 * If the paragraph's only content is a single text node holding a block-extension
 * comment, return the corresponding extension node — otherwise null.
 */
const tryParseBlockExtensionParagraph = (node: AdfNode): AdfNode | null => {
  if (node.type !== "paragraph") return null
  const content = node.content ?? []
  if (content.length !== 1) return null
  const child = content[0]
  if (!child || child.type !== "text" || !child.text) return null
  const match = BLOCK_EXTENSION_RE.exec(child.text)
  if (!match) return null
  // bodiedExtension requires a non-empty body in the ADF schema; we have no
  // body content to attach, so we down-grade to plain extension regardless of
  // the matched kind. The macro identity (key + type) is preserved.
  const [, , key, type] = match
  return { type: "extension", attrs: buildExtensionAttrs(key, type) }
}

const transform = (node: AdfNode): AdfNode => {
  const blockExt = tryParseBlockExtensionParagraph(node)
  if (blockExt) return blockExt

  if (!node.content) return node

  const newContent: Array<AdfNode> = []
  for (const child of node.content) {
    if (child.type === "text" && child.text) {
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
  return { ...node, content: newContent }
}

/** Walk the document tree and rewrite placeholder text into proper ADF nodes. */
export const revertPlaceholders = (doc: unknown): unknown => transform(doc as AdfNode)
