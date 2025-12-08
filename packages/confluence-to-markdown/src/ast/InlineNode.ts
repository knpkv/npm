/**
 * Inline AST node types for text-level content.
 *
 * @module
 */
import * as Schema from "effect/Schema"

/**
 * Optional raw Confluence HTML for exact roundtrip preservation.
 * When present, the Confluence serializer will output this instead of reconstructing.
 *
 * @category InlineNode
 */
export const RawConfluence = Schema.optional(Schema.String)

/**
 * Plain text content.
 *
 * @example
 * ```typescript
 * import { Text } from "@knpkv/confluence-to-markdown/ast"
 *
 * const text = new Text({ value: "Hello world" })
 * ```
 *
 * @category InlineNode
 */
export class Text extends Schema.TaggedClass<Text>()("Text", {
  value: Schema.String
}) {}

/**
 * Inline code span.
 *
 * @example
 * ```typescript
 * import { InlineCode } from "@knpkv/confluence-to-markdown/ast"
 *
 * const code = new InlineCode({ value: "const x = 1" })
 * ```
 *
 * @category InlineNode
 */
export class InlineCode extends Schema.TaggedClass<InlineCode>()("InlineCode", {
  value: Schema.String
}) {}

/**
 * Line break element.
 *
 * @example
 * ```typescript
 * import { LineBreak } from "@knpkv/confluence-to-markdown/ast"
 *
 * const br = new LineBreak({})
 * ```
 *
 * @category InlineNode
 */
export class LineBreak extends Schema.TaggedClass<LineBreak>()("LineBreak", {}) {}

/**
 * Unsupported inline element - preserves raw content for round-tripping.
 *
 * @example
 * ```typescript
 * import { UnsupportedInline } from "@knpkv/confluence-to-markdown/ast"
 *
 * const unknown = new UnsupportedInline({
 *   raw: "<custom-tag>content</custom-tag>",
 *   source: "confluence"
 * })
 * ```
 *
 * @category InlineNode
 */
export class UnsupportedInline extends Schema.TaggedClass<UnsupportedInline>()("UnsupportedInline", {
  raw: Schema.String,
  source: Schema.Literal("confluence", "markdown")
}) {}

/**
 * Emoticon/emoji element.
 *
 * @example
 * ```typescript
 * import { Emoticon } from "@knpkv/confluence-to-markdown/ast"
 *
 * const emoji = new Emoticon({
 *   shortname: ":grinning:",
 *   emojiId: "1f600",
 *   fallback: "😀"
 * })
 * ```
 *
 * @category InlineNode
 */
export class Emoticon extends Schema.TaggedClass<Emoticon>()("Emoticon", {
  shortname: Schema.String,
  emojiId: Schema.String,
  fallback: Schema.String,
  rawConfluence: RawConfluence
}) {}

/**
 * User mention element.
 *
 * @example
 * ```typescript
 * import { UserMention } from "@knpkv/confluence-to-markdown/ast"
 *
 * const mention = new UserMention({ accountId: "557058:..." })
 * ```
 *
 * @category InlineNode
 */
export class UserMention extends Schema.TaggedClass<UserMention>()("UserMention", {
  accountId: Schema.String,
  rawConfluence: RawConfluence
}) {}

/**
 * Date/time element.
 *
 * @example
 * ```typescript
 * import { DateTime } from "@knpkv/confluence-to-markdown/ast"
 *
 * const date = new DateTime({ datetime: "2026-01-01" })
 * ```
 *
 * @category InlineNode
 */
export class DateTime extends Schema.TaggedClass<DateTime>()("DateTime", {
  datetime: Schema.String,
  rawConfluence: RawConfluence
}) {}

/**
 * Underlined text.
 *
 * @category InlineNode
 */
export class Underline extends Schema.TaggedClass<Underline>()("Underline", {
  children: Schema.suspend(() => Schema.Array(InlineNodeBase))
}) {}

/**
 * Subscript text.
 *
 * @category InlineNode
 */
export class Subscript extends Schema.TaggedClass<Subscript>()("Subscript", {
  children: Schema.suspend(() => Schema.Array(InlineNodeBase))
}) {}

/**
 * Superscript text.
 *
 * @category InlineNode
 */
export class Superscript extends Schema.TaggedClass<Superscript>()("Superscript", {
  children: Schema.suspend(() => Schema.Array(InlineNodeBase))
}) {}

/**
 * Strikethrough text.
 *
 * @category InlineNode
 */
export class Strikethrough extends Schema.TaggedClass<Strikethrough>()("Strikethrough", {
  children: Schema.suspend(() => Schema.Array(InlineNodeBase))
}) {}

/**
 * Colored text with CSS color value.
 *
 * @category InlineNode
 */
export class ColoredText extends Schema.TaggedClass<ColoredText>()("ColoredText", {
  color: Schema.String,
  children: Schema.suspend(() => Schema.Array(InlineNodeBase))
}) {}

/**
 * Highlighted text with background color.
 *
 * @category InlineNode
 */
export class Highlight extends Schema.TaggedClass<Highlight>()("Highlight", {
  backgroundColor: Schema.String,
  children: Schema.suspend(() => Schema.Array(InlineNodeBase))
}) {}

// Forward declaration for recursive types
// Define InlineNode union schema first (without recursive types)
const InlineNodeBase = Schema.Union(
  Text,
  InlineCode,
  LineBreak,
  Emoticon,
  UserMention,
  DateTime,
  UnsupportedInline
)

/**
 * Inline node children schema - use this for recursive inline content.
 *
 * @category InlineNode
 */
export const InlineNodeChildren: Schema.Schema<ReadonlyArray<InlineNode>> = Schema.suspend(
  () => Schema.Array(InlineNode)
)

/**
 * Strong/bold text.
 *
 * @example
 * ```typescript
 * import { Strong, Text } from "@knpkv/confluence-to-markdown/ast"
 *
 * const bold = new Strong({ children: [new Text({ value: "important" })] })
 * ```
 *
 * @category InlineNode
 */
export class Strong extends Schema.TaggedClass<Strong>()("Strong", {
  children: Schema.Array(InlineNodeBase)
}) {}

/**
 * Emphasized/italic text.
 *
 * @example
 * ```typescript
 * import { Emphasis, Text } from "@knpkv/confluence-to-markdown/ast"
 *
 * const italic = new Emphasis({ children: [new Text({ value: "emphasized" })] })
 * ```
 *
 * @category InlineNode
 */
export class Emphasis extends Schema.TaggedClass<Emphasis>()("Emphasis", {
  children: Schema.Array(InlineNodeBase)
}) {}

/**
 * Hyperlink with optional title.
 *
 * @example
 * ```typescript
 * import { Link, Text } from "@knpkv/confluence-to-markdown/ast"
 *
 * const link = new Link({
 *   href: "https://example.com",
 *   title: "Example",
 *   children: [new Text({ value: "Click here" })]
 * })
 * ```
 *
 * @category InlineNode
 */
export class Link extends Schema.TaggedClass<Link>()("Link", {
  href: Schema.String,
  title: Schema.optional(Schema.String),
  children: Schema.Array(InlineNodeBase),
  rawConfluence: RawConfluence
}) {}

/**
 * Union of all inline node types.
 *
 * @category InlineNode
 */
export const InlineNode = Schema.Union(
  Text,
  Strong,
  Emphasis,
  InlineCode,
  Link,
  LineBreak,
  Emoticon,
  UserMention,
  DateTime,
  Underline,
  Subscript,
  Superscript,
  Strikethrough,
  ColoredText,
  Highlight,
  UnsupportedInline
)

/**
 * Type for inline nodes.
 *
 * @category Types
 */
export type InlineNode =
  | Text
  | Strong
  | Emphasis
  | InlineCode
  | Link
  | LineBreak
  | Emoticon
  | UserMention
  | DateTime
  | Underline
  | Subscript
  | Superscript
  | Strikethrough
  | ColoredText
  | Highlight
  | UnsupportedInline

/**
 * Schema type helper for InlineNode.
 *
 * @category Types
 */
export type InlineNodeSchema = typeof InlineNode
