/**
 * Block-level AST node types for structural content.
 *
 * @module
 */
import * as Schema from "effect/Schema"
import { InlineNode, type InlineNode as InlineNodeType } from "./InlineNode.js"

/**
 * Schema version for migration support.
 *
 * @category Version
 */
export const SchemaVersion = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.optionalWith({ default: () => 1 })
)

/**
 * Optional raw source for exact roundtrip preservation.
 *
 * @category BlockNode
 */
export const RawSource = Schema.optional(Schema.String)

/**
 * Heading element (h1-h6).
 *
 * @example
 * ```typescript
 * import { Heading, Text } from "@knpkv/atlassian-common/ast"
 *
 * const h1 = new Heading({
 *   level: 1,
 *   children: [new Text({ value: "Introduction" })]
 * })
 * ```
 *
 * @category BlockNode
 */
export class Heading extends Schema.TaggedClass<Heading>()("Heading", {
  version: SchemaVersion,
  level: Schema.Literal(1, 2, 3, 4, 5, 6),
  children: Schema.Array(InlineNode),
  rawSource: RawSource
}) {}

/**
 * Text alignment options.
 *
 * @category BlockNode
 */
export const TextAlignment = Schema.Literal("left", "center", "right")

/**
 * Type for TextAlignment.
 *
 * @category Types
 */
export type TextAlignment = Schema.Schema.Type<typeof TextAlignment>

/**
 * Paragraph element with optional alignment and indentation.
 *
 * @example
 * ```typescript
 * import { Paragraph, Text } from "@knpkv/atlassian-common/ast"
 *
 * const para = new Paragraph({
 *   children: [new Text({ value: "Hello world" })]
 * })
 * ```
 *
 * @category BlockNode
 */
export class Paragraph extends Schema.TaggedClass<Paragraph>()("Paragraph", {
  version: SchemaVersion,
  alignment: Schema.optional(TextAlignment),
  indent: Schema.optional(Schema.Number),
  children: Schema.Array(InlineNode),
  rawSource: RawSource
}) {}

/**
 * Code block with optional language.
 *
 * @example
 * ```typescript
 * import { CodeBlock } from "@knpkv/atlassian-common/ast"
 *
 * const code = new CodeBlock({
 *   language: "typescript",
 *   code: "const x = 1"
 * })
 * ```
 *
 * @category BlockNode
 */
export class CodeBlock extends Schema.TaggedClass<CodeBlock>()("CodeBlock", {
  version: SchemaVersion,
  language: Schema.optional(Schema.String),
  code: Schema.String,
  rawSource: RawSource
}) {}

/**
 * Thematic break / horizontal rule.
 *
 * @example
 * ```typescript
 * import { ThematicBreak } from "@knpkv/atlassian-common/ast"
 *
 * const hr = new ThematicBreak({})
 * ```
 *
 * @category BlockNode
 */
export class ThematicBreak extends Schema.TaggedClass<ThematicBreak>()("ThematicBreak", {
  rawSource: RawSource
}) {}

/**
 * Attachment reference for images.
 *
 * @category BlockNode
 */
export const ImageAttachment = Schema.Struct({
  filename: Schema.String,
  version: Schema.optional(Schema.Number)
})

/**
 * Type for ImageAttachment.
 *
 * @category Types
 */
export type ImageAttachment = Schema.Schema.Type<typeof ImageAttachment>

/**
 * Image element with support for both URL and attachments.
 *
 * @example
 * ```typescript
 * import { Image } from "@knpkv/atlassian-common/ast"
 *
 * const img = new Image({
 *   src: "https://example.com/image.png",
 *   alt: "Example image"
 * })
 * ```
 *
 * @category BlockNode
 */
export class Image extends Schema.TaggedClass<Image>()("Image", {
  version: SchemaVersion,
  src: Schema.optional(Schema.String),
  attachment: Schema.optional(ImageAttachment),
  alt: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  align: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  rawSource: RawSource
}) {}

/**
 * Table cell element.
 *
 * @example
 * ```typescript
 * import { TableCell, Text } from "@knpkv/atlassian-common/ast"
 *
 * const cell = new TableCell({
 *   isHeader: true,
 *   children: [new Text({ value: "Header" })]
 * })
 * ```
 *
 * @category BlockNode
 */
export class TableCell extends Schema.TaggedClass<TableCell>()("TableCell", {
  isHeader: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  children: Schema.Array(InlineNode),
  rawSource: RawSource
}) {}

/**
 * Table row element.
 *
 * @category BlockNode
 */
export class TableRow extends Schema.TaggedClass<TableRow>()("TableRow", {
  cells: Schema.Array(TableCell),
  rawSource: RawSource
}) {}

/**
 * Table element with optional header row.
 *
 * @category BlockNode
 */
export class Table extends Schema.TaggedClass<Table>()("Table", {
  version: SchemaVersion,
  header: Schema.optional(TableRow),
  rows: Schema.Array(TableRow),
  rawSource: RawSource
}) {}

/**
 * Unsupported block element - preserves raw content for round-tripping.
 *
 * @category BlockNode
 */
export class UnsupportedBlock extends Schema.TaggedClass<UnsupportedBlock>()("UnsupportedBlock", {
  rawHtml: Schema.optional(Schema.String),
  rawMarkdown: Schema.optional(Schema.String),
  rawAdf: Schema.optional(Schema.String),
  source: Schema.Literal("confluence", "markdown", "adf")
}) {}

// Non-recursive block nodes
const SimpleBlockNode = Schema.Union(
  Heading,
  Paragraph,
  CodeBlock,
  ThematicBreak,
  Image,
  Table,
  UnsupportedBlock
)

/**
 * Block quote element with nested block content.
 *
 * @category BlockNode
 */
export const BlockQuote = Schema.Struct({
  _tag: Schema.Literal("BlockQuote"),
  version: SchemaVersion,
  children: Schema.Array(SimpleBlockNode),
  rawSource: RawSource
})

/**
 * Type for BlockQuote.
 *
 * @category Types
 */
export type BlockQuote = Schema.Schema.Type<typeof BlockQuote>

/**
 * List item with nested block content.
 *
 * @category BlockNode
 */
export const ListItem = Schema.Struct({
  _tag: Schema.Literal("ListItem"),
  checked: Schema.optional(Schema.Boolean),
  children: Schema.Array(SimpleBlockNode),
  rawSource: RawSource
})

/**
 * Type for ListItem.
 *
 * @category Types
 */
export type ListItem = Schema.Schema.Type<typeof ListItem>

/**
 * List element (ordered or unordered).
 *
 * @category BlockNode
 */
export const List = Schema.Struct({
  _tag: Schema.Literal("List"),
  version: SchemaVersion,
  ordered: Schema.Boolean,
  start: Schema.optional(Schema.Number),
  children: Schema.Array(ListItem),
  rawSource: RawSource
})

/**
 * Type for List.
 *
 * @category Types
 */
export type List = Schema.Schema.Type<typeof List>

/**
 * Task item with status.
 *
 * @category BlockNode
 */
export const TaskItem = Schema.Struct({
  _tag: Schema.Literal("TaskItem"),
  id: Schema.String,
  uuid: Schema.String,
  status: Schema.Literal("incomplete", "complete"),
  body: Schema.Array(InlineNode),
  rawSource: RawSource
})

/**
 * Type for TaskItem.
 *
 * @category Types
 */
export type TaskItem = Schema.Schema.Type<typeof TaskItem>

/**
 * Task list.
 *
 * @category BlockNode
 */
export const TaskList = Schema.Struct({
  _tag: Schema.Literal("TaskList"),
  version: SchemaVersion,
  children: Schema.Array(TaskItem),
  rawSource: RawSource
})

/**
 * Type for TaskList.
 *
 * @category Types
 */
export type TaskList = Schema.Schema.Type<typeof TaskList>

/**
 * Union of all block node types.
 *
 * @category BlockNode
 */
export const BlockNode = Schema.Union(
  Heading,
  Paragraph,
  CodeBlock,
  ThematicBreak,
  BlockQuote,
  Image,
  Table,
  List,
  TaskList,
  UnsupportedBlock
)

/**
 * Type for block nodes.
 *
 * @category Types
 */
export type BlockNode =
  | Heading
  | Paragraph
  | CodeBlock
  | ThematicBreak
  | BlockQuote
  | Image
  | Table
  | List
  | TaskList
  | UnsupportedBlock

/**
 * Type helper for inline node children in blocks.
 *
 * @category Types
 */
export type { InlineNodeType as InlineNode }

/**
 * Simple block nodes (non-recursive).
 *
 * @category BlockNode
 */
export { SimpleBlockNode }
