import { Effect, Predicate, Result, Schema } from "effect"

import { ExternalNavigationUrl, MediaRef } from "./UrlPolicy.js"

const MAXIMUM_DEPTH = 20
const MAXIMUM_NODES = 10_000
const MAXIMUM_TEXT_BYTES = 16 * 1024
const MAXIMUM_LINKS = 500
const MAXIMUM_MEDIA = 500
const MAXIMUM_ENCODED_BYTES = 256 * 1024

/** Public hard limits applied to every canonical rich document. */
export const RICH_DOCUMENT_LIMITS = {
  maximumDepth: MAXIMUM_DEPTH,
  maximumNodes: MAXIMUM_NODES,
  maximumTextBytes: MAXIMUM_TEXT_BYTES,
  maximumLinks: MAXIMUM_LINKS,
  maximumMedia: MAXIMUM_MEDIA,
  maximumEncodedBytes: MAXIMUM_ENCODED_BYTES
}

const RichTextMark = Schema.Literals(["bold", "italic", "strike", "code"])
const RichTextMarks = Schema.Array(RichTextMark).check(
  Schema.isMaxLength(4),
  Schema.makeFilter((marks) => new Set(marks).size === marks.length, { expected: "unique text marks" })
)
const RichText = Schema.String.check(Schema.isMaxLength(MAXIMUM_TEXT_BYTES))
const RichAltText = Schema.String.check(Schema.isMaxLength(500))
const RichReference = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/u)
)

/** Escaped text leaf with a closed set of presentation-only marks. */
export interface RichTextNode {
  readonly _tag: "text"
  readonly text: string
  readonly marks: ReadonlyArray<"bold" | "italic" | "strike" | "code">
}

/** Explicit inline hard break. */
export interface RichHardBreakNode {
  readonly _tag: "hard-break"
}

/** Safe external link whose children cannot contain another link. */
export interface RichLinkNode {
  readonly _tag: "link"
  readonly href: ExternalNavigationUrl
  readonly children: ReadonlyArray<RichTextNode | RichHardBreakNode>
}

/** Opaque person or entity mention. */
export interface RichMentionNode {
  readonly _tag: "mention"
  readonly reference: string
  readonly label: string
}

/** Bounded emoji text, rendered without provider HTML. */
export interface RichEmojiNode {
  readonly _tag: "emoji"
  readonly text: string
}

/** Same-origin opaque media reference. */
export interface RichMediaNode {
  readonly _tag: "media"
  readonly mediaRef: MediaRef
  readonly alt: string
}

/** Canonical inline rich node. */
export type RichInlineNode =
  | RichTextNode
  | RichHardBreakNode
  | RichLinkNode
  | RichMentionNode
  | RichEmojiNode
  | RichMediaNode

interface RichLinkNodeEncoded extends Omit<RichLinkNode, "href"> {
  readonly href: string
}

interface RichMediaNodeEncoded extends Omit<RichMediaNode, "mediaRef"> {
  readonly mediaRef: string
}

type RichInlineNodeEncoded =
  | RichTextNode
  | RichHardBreakNode
  | RichLinkNodeEncoded
  | RichMentionNode
  | RichEmojiNode
  | RichMediaNodeEncoded

export const RichTextNode: Schema.Codec<RichTextNode> = Schema.Struct({
  _tag: Schema.Literal("text"),
  text: RichText,
  marks: RichTextMarks
})

export const RichHardBreakNode: Schema.Codec<RichHardBreakNode> = Schema.Struct({
  _tag: Schema.Literal("hard-break")
})

export const RichLinkNode: Schema.Codec<RichLinkNode, RichLinkNodeEncoded> = Schema.Struct({
  _tag: Schema.Literal("link"),
  href: ExternalNavigationUrl,
  children: Schema.Array(Schema.Union([RichTextNode, RichHardBreakNode]))
})

export const RichMentionNode: Schema.Codec<RichMentionNode> = Schema.Struct({
  _tag: Schema.Literal("mention"),
  reference: RichReference,
  label: RichAltText
})

export const RichEmojiNode: Schema.Codec<RichEmojiNode> = Schema.Struct({
  _tag: Schema.Literal("emoji"),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32))
})

export const RichMediaNode: Schema.Codec<RichMediaNode, RichMediaNodeEncoded> = Schema.Struct({
  _tag: Schema.Literal("media"),
  mediaRef: MediaRef,
  alt: RichAltText
})

export const RichInlineNode: Schema.Codec<RichInlineNode, RichInlineNodeEncoded> = Schema.Union([
  RichTextNode,
  RichHardBreakNode,
  RichLinkNode,
  RichMentionNode,
  RichEmojiNode,
  RichMediaNode
])

/** Paragraph block. */
export interface RichParagraphNode {
  readonly _tag: "paragraph"
  readonly children: ReadonlyArray<RichInlineNode>
}

/** Heading block with a semantic level. */
export interface RichHeadingNode {
  readonly _tag: "heading"
  readonly level: number
  readonly children: ReadonlyArray<RichInlineNode>
}

/** Plain code block; code is never interpreted as HTML. */
export interface RichCodeBlockNode {
  readonly _tag: "code-block"
  readonly language: string | null
  readonly text: string
}

/** Horizontal separator block. */
export interface RichRuleNode {
  readonly _tag: "rule"
}

/** Block quote containing canonical blocks. */
export interface RichBlockQuoteNode {
  readonly _tag: "blockquote"
  readonly children: ReadonlyArray<RichBlockNode>
}

/** List item containing canonical blocks. */
export interface RichListItemNode {
  readonly _tag: "list-item"
  readonly children: ReadonlyArray<RichBlockNode>
}

/** Bullet list. */
export interface RichBulletListNode {
  readonly _tag: "bullet-list"
  readonly children: ReadonlyArray<RichListItemNode>
}

/** Ordered list with a bounded starting ordinal. */
export interface RichOrderedListNode {
  readonly _tag: "ordered-list"
  readonly start: number
  readonly children: ReadonlyArray<RichListItemNode>
}

/** Canonical rich block. */
export type RichBlockNode =
  | RichParagraphNode
  | RichHeadingNode
  | RichCodeBlockNode
  | RichRuleNode
  | RichBlockQuoteNode
  | RichBulletListNode
  | RichOrderedListNode

interface RichParagraphNodeEncoded extends Omit<RichParagraphNode, "children"> {
  readonly children: ReadonlyArray<RichInlineNodeEncoded>
}

interface RichHeadingNodeEncoded extends Omit<RichHeadingNode, "children"> {
  readonly children: ReadonlyArray<RichInlineNodeEncoded>
}

interface RichBlockQuoteNodeEncoded extends Omit<RichBlockQuoteNode, "children"> {
  readonly children: ReadonlyArray<RichBlockNodeEncoded>
}

interface RichListItemNodeEncoded extends Omit<RichListItemNode, "children"> {
  readonly children: ReadonlyArray<RichBlockNodeEncoded>
}

interface RichBulletListNodeEncoded extends Omit<RichBulletListNode, "children"> {
  readonly children: ReadonlyArray<RichListItemNodeEncoded>
}

interface RichOrderedListNodeEncoded extends Omit<RichOrderedListNode, "children"> {
  readonly children: ReadonlyArray<RichListItemNodeEncoded>
}

type RichBlockNodeEncoded =
  | RichParagraphNodeEncoded
  | RichHeadingNodeEncoded
  | RichCodeBlockNode
  | RichRuleNode
  | RichBlockQuoteNodeEncoded
  | RichBulletListNodeEncoded
  | RichOrderedListNodeEncoded

export const RichParagraphNode: Schema.Codec<RichParagraphNode, RichParagraphNodeEncoded> = Schema.Struct({
  _tag: Schema.Literal("paragraph"),
  children: Schema.Array(RichInlineNode)
})

export const RichHeadingNode: Schema.Codec<RichHeadingNode, RichHeadingNodeEncoded> = Schema.Struct({
  _tag: Schema.Literal("heading"),
  level: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 6 })),
  children: Schema.Array(RichInlineNode)
})

export const RichCodeBlockNode: Schema.Codec<RichCodeBlockNode> = Schema.Struct({
  _tag: Schema.Literal("code-block"),
  language: Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(32))),
  text: RichText
})

export const RichRuleNode: Schema.Codec<RichRuleNode> = Schema.Struct({ _tag: Schema.Literal("rule") })

export const RichListItemNode: Schema.Codec<RichListItemNode, RichListItemNodeEncoded> = Schema.Struct({
  _tag: Schema.Literal("list-item"),
  children: Schema.Array(
    Schema.suspend((): Schema.Codec<RichBlockNode, RichBlockNodeEncoded> => RichBlockNode)
  )
})

export const RichBlockQuoteNode: Schema.Codec<RichBlockQuoteNode, RichBlockQuoteNodeEncoded> = Schema.Struct({
  _tag: Schema.Literal("blockquote"),
  children: Schema.Array(
    Schema.suspend((): Schema.Codec<RichBlockNode, RichBlockNodeEncoded> => RichBlockNode)
  )
})

export const RichBulletListNode: Schema.Codec<RichBulletListNode, RichBulletListNodeEncoded> = Schema.Struct({
  _tag: Schema.Literal("bullet-list"),
  children: Schema.Array(RichListItemNode)
})

export const RichOrderedListNode: Schema.Codec<RichOrderedListNode, RichOrderedListNodeEncoded> = Schema.Struct({
  _tag: Schema.Literal("ordered-list"),
  start: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  children: Schema.Array(RichListItemNode)
})

export const RichBlockNode: Schema.Codec<RichBlockNode, RichBlockNodeEncoded> = Schema.Union([
  RichParagraphNode,
  RichHeadingNode,
  RichCodeBlockNode,
  RichRuleNode,
  RichBlockQuoteNode,
  RichBulletListNode,
  RichOrderedListNode
])

/** Versioned canonical rich document without any raw HTML escape hatch. */
export interface RichDocumentV1 {
  readonly _tag: "rich-document"
  readonly version: 1
  readonly children: ReadonlyArray<RichBlockNode>
}

interface RichDocumentV1Encoded extends Omit<RichDocumentV1, "children"> {
  readonly children: ReadonlyArray<RichBlockNodeEncoded>
}

export const RichDocumentV1: Schema.Codec<RichDocumentV1, RichDocumentV1Encoded> = Schema.Struct({
  _tag: Schema.Literal("rich-document"),
  version: Schema.Literal(1),
  children: Schema.Array(RichBlockNode)
})

const RichDocumentJson = Schema.fromJsonString(RichDocumentV1)

/** Canonical rich content failed schema or resource-limit validation. */
export class RichDocumentError extends Schema.TaggedErrorClass<RichDocumentError>()("RichDocumentError", {
  reason: Schema.Literals(["invalid-document", "bounds-exceeded", "encoded-size-exceeded"])
}) {}

interface RichBudget {
  nodeCount: number
  linkCount: number
  mediaCount: number
}

const textEncoder = new TextEncoder()

const preflightUnknownTree = (input: unknown): boolean => {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: input, depth: 0 }]
  let nodeCount = 0
  let linkCount = 0
  let mediaCount = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    if (current.depth > MAXIMUM_DEPTH || !Predicate.isObject(current.value)) return false
    nodeCount += 1
    if (nodeCount > MAXIMUM_NODES) return false
    if (current.value._tag === "link") linkCount += 1
    if (current.value._tag === "media") mediaCount += 1
    if (linkCount > MAXIMUM_LINKS || mediaCount > MAXIMUM_MEDIA) return false
    const text = current.value.text
    if (typeof text === "string" && textEncoder.encode(text).byteLength > MAXIMUM_TEXT_BYTES) return false
    const children = current.value.children
    if (Array.isArray(children)) {
      for (const child of children) stack.push({ value: child, depth: current.depth + 1 })
    }
  }
  return true
}

/** Validate a canonical document and all structural, text, link, media, and encoded-size bounds. */
export const validateRichDocumentV1 = Effect.fn("RichDocument.validate")(function*(input: unknown) {
  if (!preflightUnknownTree(input)) return yield* new RichDocumentError({ reason: "bounds-exceeded" })
  const typedResult = Schema.decodeUnknownResult(Schema.toType(RichDocumentV1))(input)
  const document = Result.isSuccess(typedResult)
    ? typedResult.success
    : yield* Schema.decodeUnknownEffect(RichDocumentV1)(input).pipe(
      Effect.mapError(() => new RichDocumentError({ reason: "invalid-document" }))
    )
  const encoded = yield* Schema.encodeUnknownEffect(RichDocumentJson)(document).pipe(
    Effect.mapError(() => new RichDocumentError({ reason: "invalid-document" }))
  )
  if (textEncoder.encode(encoded).byteLength > MAXIMUM_ENCODED_BYTES) {
    return yield* new RichDocumentError({ reason: "encoded-size-exceeded" })
  }
  return document
})

const decodeString = (schema: Schema.Codec<string>, input: unknown): string | undefined => {
  const result = Schema.decodeUnknownResult(schema)(input)
  return Result.isSuccess(result) ? result.success : undefined
}

const rawChildren = (input: Readonly<Record<PropertyKey, unknown>>): ReadonlyArray<unknown> =>
  Array.isArray(input.children) ? input.children : []

const addNode = (budget: RichBudget): boolean => {
  if (budget.nodeCount >= MAXIMUM_NODES) return false
  budget.nodeCount += 1
  return true
}

const sanitizeLinkChildren = (
  inputs: ReadonlyArray<unknown>,
  budget: RichBudget,
  depth: number
): ReadonlyArray<RichTextNode | RichHardBreakNode> => {
  const children: Array<RichTextNode | RichHardBreakNode> = []
  for (const input of inputs) {
    if (!Predicate.isObject(input)) continue
    if (input._tag === "text") {
      const text = decodeString(RichText, input.text)
      if (text === undefined || !addNode(budget)) continue
      const marksResult = Schema.decodeUnknownResult(RichTextMarks)(input.marks)
      children.push({ _tag: "text", text, marks: Result.isSuccess(marksResult) ? marksResult.success : [] })
    } else if (input._tag === "hard-break" && addNode(budget) && depth <= MAXIMUM_DEPTH) {
      children.push({ _tag: "hard-break" })
    }
  }
  return children
}

const sanitizeInline = (
  input: unknown,
  budget: RichBudget,
  depth: number
): ReadonlyArray<RichInlineNode> => {
  if (depth > MAXIMUM_DEPTH || !Predicate.isObject(input)) return []
  if (input._tag === "text") {
    const text = decodeString(RichText, input.text)
    if (text === undefined || !addNode(budget)) return []
    const marksResult = Schema.decodeUnknownResult(RichTextMarks)(input.marks)
    return [{ _tag: "text", text, marks: Result.isSuccess(marksResult) ? marksResult.success : [] }]
  }
  if (input._tag === "hard-break") return addNode(budget) ? [{ _tag: "hard-break" }] : []
  if (input._tag === "link") {
    const children = sanitizeLinkChildren(rawChildren(input), budget, depth + 1)
    const href = Schema.decodeUnknownResult(ExternalNavigationUrl)(input.href)
    if (Result.isFailure(href) || budget.linkCount >= MAXIMUM_LINKS || !addNode(budget)) return children
    budget.linkCount += 1
    return [{ _tag: "link", href: href.success, children }]
  }
  if (input._tag === "mention") {
    const reference = decodeString(RichReference, input.reference)
    const label = decodeString(RichAltText, input.label)
    return reference !== undefined && label !== undefined && addNode(budget)
      ? [{ _tag: "mention", reference, label }]
      : []
  }
  if (input._tag === "emoji") {
    const text = decodeString(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32)), input.text)
    return text !== undefined && addNode(budget) ? [{ _tag: "emoji", text }] : []
  }
  if (input._tag === "media") {
    const mediaRef = Schema.decodeUnknownResult(MediaRef)(input.mediaRef)
    const alt = decodeString(RichAltText, input.alt)
    if (Result.isFailure(mediaRef) || alt === undefined || budget.mediaCount >= MAXIMUM_MEDIA || !addNode(budget)) {
      return []
    }
    budget.mediaCount += 1
    return [{ _tag: "media", mediaRef: mediaRef.success, alt }]
  }
  return []
}

const sanitizeInlines = (
  inputs: ReadonlyArray<unknown>,
  budget: RichBudget,
  depth: number
): ReadonlyArray<RichInlineNode> => inputs.flatMap((input) => sanitizeInline(input, budget, depth))

const sanitizeListItem = (input: unknown, budget: RichBudget, depth: number): RichListItemNode | undefined => {
  if (depth > MAXIMUM_DEPTH || !Predicate.isObject(input) || input._tag !== "list-item" || !addNode(budget)) {
    return undefined
  }
  return { _tag: "list-item", children: sanitizeBlocks(rawChildren(input), budget, depth + 1) }
}

const sanitizeBlock = (input: unknown, budget: RichBudget, depth: number): RichBlockNode | undefined => {
  if (depth > MAXIMUM_DEPTH || !Predicate.isObject(input)) return undefined
  if (input._tag === "paragraph" && addNode(budget)) {
    return { _tag: "paragraph", children: sanitizeInlines(rawChildren(input), budget, depth + 1) }
  }
  if (input._tag === "heading") {
    const level = Schema.decodeUnknownResult(
      Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 6 }))
    )(input.level)
    return Result.isSuccess(level) && addNode(budget)
      ? { _tag: "heading", level: level.success, children: sanitizeInlines(rawChildren(input), budget, depth + 1) }
      : undefined
  }
  if (input._tag === "code-block") {
    const text = decodeString(RichText, input.text)
    const language = input.language === null
      ? null
      : decodeString(
        Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(32)),
        input.language
      )
    return text !== undefined && language !== undefined && addNode(budget)
      ? { _tag: "code-block", language, text }
      : undefined
  }
  if (input._tag === "rule") return addNode(budget) ? { _tag: "rule" } : undefined
  if (input._tag === "blockquote" && addNode(budget)) {
    return { _tag: "blockquote", children: sanitizeBlocks(rawChildren(input), budget, depth + 1) }
  }
  if (input._tag === "bullet-list" || input._tag === "ordered-list") {
    if (!addNode(budget)) return undefined
    const children = rawChildren(input).flatMap((child) => {
      const sanitized = sanitizeListItem(child, budget, depth + 1)
      return sanitized === undefined ? [] : [sanitized]
    })
    if (input._tag === "bullet-list") return { _tag: "bullet-list", children }
    const start = Schema.decodeUnknownResult(
      Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1_000_000 }))
    )(input.start)
    return Result.isSuccess(start) ? { _tag: "ordered-list", start: start.success, children } : undefined
  }
  return undefined
}

function sanitizeBlocks(
  inputs: ReadonlyArray<unknown>,
  budget: RichBudget,
  depth: number
): ReadonlyArray<RichBlockNode> {
  const blocks: Array<RichBlockNode> = []
  for (const input of inputs) {
    const block = sanitizeBlock(input, budget, depth)
    if (block !== undefined) blocks.push(block)
    if (budget.nodeCount >= MAXIMUM_NODES) break
  }
  return blocks
}

const RawRichDocument = Schema.Struct({
  _tag: Schema.Literal("rich-document"),
  version: Schema.Literal(1),
  children: Schema.Array(Schema.Unknown)
})

/** Drop unsupported/provider-active nodes and return a validated canonical document. */
export const sanitizeRichDocumentV1 = Effect.fn("RichDocument.sanitize")(function*(input: unknown) {
  const raw = yield* Schema.decodeUnknownEffect(RawRichDocument)(input).pipe(
    Effect.mapError(() => new RichDocumentError({ reason: "invalid-document" }))
  )
  const budget: RichBudget = { nodeCount: 1, linkCount: 0, mediaCount: 0 }
  const document: RichDocumentV1 = {
    _tag: "rich-document",
    version: 1,
    children: sanitizeBlocks(raw.children, budget, 1)
  }
  return yield* validateRichDocumentV1(document)
})
