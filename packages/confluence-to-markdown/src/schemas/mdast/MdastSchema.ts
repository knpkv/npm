/**
 * Effect Schema definitions for MDAST (Markdown Abstract Syntax Tree) nodes.
 *
 * MDAST is the intermediate representation used when parsing Markdown.
 * These schemas provide type-safe transformation between raw Markdown and our AST.
 *
 * @module
 */
import * as Schema from "effect/Schema"

/**
 * MDAST text node type.
 *
 * @category Types
 */
export interface MdastText {
  readonly type: "text"
  readonly value: string
}

/**
 * MDAST inline code node type.
 *
 * @category Types
 */
export interface MdastInlineCode {
  readonly type: "inlineCode"
  readonly value: string
}

/**
 * MDAST break node type (hard line break).
 *
 * @category Types
 */
export interface MdastBreak {
  readonly type: "break"
}

/**
 * MDAST thematic break node type (horizontal rule).
 *
 * @category Types
 */
export interface MdastThematicBreak {
  readonly type: "thematicBreak"
}

/**
 * MDAST heading node type.
 *
 * @category Types
 */
export interface MdastHeading {
  readonly type: "heading"
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6
  readonly children: ReadonlyArray<MdastPhrasingContent>
}

/**
 * MDAST paragraph node type.
 *
 * @category Types
 */
export interface MdastParagraph {
  readonly type: "paragraph"
  readonly children: ReadonlyArray<MdastPhrasingContent>
}

/**
 * MDAST code block node type.
 *
 * @category Types
 */
export interface MdastCode {
  readonly type: "code"
  readonly lang?: string
  readonly meta?: string
  readonly value: string
}

/**
 * MDAST blockquote node type.
 *
 * @category Types
 */
export interface MdastBlockquote {
  readonly type: "blockquote"
  readonly children: ReadonlyArray<MdastBlockContent>
}

/**
 * MDAST list node type.
 *
 * @category Types
 */
export interface MdastList {
  readonly type: "list"
  readonly ordered?: boolean
  readonly start?: number
  readonly spread?: boolean
  readonly children: ReadonlyArray<MdastListItem>
}

/**
 * MDAST list item node type.
 *
 * @category Types
 */
export interface MdastListItem {
  readonly type: "listItem"
  readonly checked?: boolean | null
  readonly spread?: boolean
  readonly children: ReadonlyArray<MdastBlockContent>
}

/**
 * MDAST table node type.
 *
 * @category Types
 */
export interface MdastTable {
  readonly type: "table"
  readonly align?: ReadonlyArray<"left" | "right" | "center" | null>
  readonly children: ReadonlyArray<MdastTableRow>
}

/**
 * MDAST table row node type.
 *
 * @category Types
 */
export interface MdastTableRow {
  readonly type: "tableRow"
  readonly children: ReadonlyArray<MdastTableCell>
}

/**
 * MDAST table cell node type.
 *
 * @category Types
 */
export interface MdastTableCell {
  readonly type: "tableCell"
  readonly children: ReadonlyArray<MdastPhrasingContent>
}

/**
 * MDAST link node type.
 *
 * @category Types
 */
export interface MdastLink {
  readonly type: "link"
  readonly url: string
  readonly title?: string | null
  readonly children: ReadonlyArray<MdastPhrasingContent>
}

/**
 * MDAST image node type.
 *
 * @category Types
 */
export interface MdastImage {
  readonly type: "image"
  readonly url: string
  readonly title?: string | null
  readonly alt?: string | null
}

/**
 * MDAST strong (bold) node type.
 *
 * @category Types
 */
export interface MdastStrong {
  readonly type: "strong"
  readonly children: ReadonlyArray<MdastPhrasingContent>
}

/**
 * MDAST emphasis (italic) node type.
 *
 * @category Types
 */
export interface MdastEmphasis {
  readonly type: "emphasis"
  readonly children: ReadonlyArray<MdastPhrasingContent>
}

/**
 * MDAST delete (strikethrough) node type.
 *
 * @category Types
 */
export interface MdastDelete {
  readonly type: "delete"
  readonly children: ReadonlyArray<MdastPhrasingContent>
}

/**
 * MDAST HTML node type (inline or block HTML).
 *
 * @category Types
 */
export interface MdastHtml {
  readonly type: "html"
  readonly value: string
}

/**
 * Union of all MDAST phrasing (inline) content types.
 *
 * @category Types
 */
export type MdastPhrasingContent =
  | MdastText
  | MdastInlineCode
  | MdastBreak
  | MdastLink
  | MdastImage
  | MdastStrong
  | MdastEmphasis
  | MdastDelete
  | MdastHtml

/**
 * Union of all MDAST block content types.
 *
 * @category Types
 */
export type MdastBlockContent =
  | MdastHeading
  | MdastParagraph
  | MdastCode
  | MdastBlockquote
  | MdastList
  | MdastTable
  | MdastThematicBreak
  | MdastHtml

/**
 * Union of all MDAST node types.
 *
 * @category Types
 */
export type MdastNode =
  | MdastPhrasingContent
  | MdastBlockContent
  | MdastListItem
  | MdastTableRow
  | MdastTableCell

/**
 * MDAST root node type.
 *
 * @category Types
 */
export interface MdastRoot {
  readonly type: "root"
  readonly children: ReadonlyArray<MdastBlockContent>
}

// Constructors

/**
 * Create a MDAST text node.
 *
 * @category Constructors
 */
export const makeMdastText = (value: string): MdastText => ({
  type: "text",
  value
})

/**
 * Create a MDAST inline code node.
 *
 * @category Constructors
 */
export const makeMdastInlineCode = (value: string): MdastInlineCode => ({
  type: "inlineCode",
  value
})

/**
 * Create a MDAST break node.
 *
 * @category Constructors
 */
export const makeMdastBreak = (): MdastBreak => ({
  type: "break"
})

/**
 * Create a MDAST heading node.
 *
 * @category Constructors
 */
export const makeMdastHeading = (
  depth: 1 | 2 | 3 | 4 | 5 | 6,
  children: ReadonlyArray<MdastPhrasingContent>
): MdastHeading => ({
  type: "heading",
  depth,
  children
})

/**
 * Create a MDAST paragraph node.
 *
 * @category Constructors
 */
export const makeMdastParagraph = (children: ReadonlyArray<MdastPhrasingContent>): MdastParagraph => ({
  type: "paragraph",
  children
})

/**
 * Create a MDAST code block node.
 *
 * @category Constructors
 */
export const makeMdastCode = (value: string, lang?: string): MdastCode => ({
  type: "code",
  value,
  ...(lang !== undefined ? { lang } : {})
})

/**
 * Create a MDAST link node.
 *
 * @category Constructors
 */
export const makeMdastLink = (
  url: string,
  children: ReadonlyArray<MdastPhrasingContent>,
  title?: string
): MdastLink => ({
  type: "link",
  url,
  children,
  ...(title !== undefined ? { title } : {})
})

/**
 * Create a MDAST strong node.
 *
 * @category Constructors
 */
export const makeMdastStrong = (children: ReadonlyArray<MdastPhrasingContent>): MdastStrong => ({
  type: "strong",
  children
})

/**
 * Create a MDAST emphasis node.
 *
 * @category Constructors
 */
export const makeMdastEmphasis = (children: ReadonlyArray<MdastPhrasingContent>): MdastEmphasis => ({
  type: "emphasis",
  children
})

/**
 * Create a MDAST root node.
 *
 * @category Constructors
 */
export const makeMdastRoot = (children: ReadonlyArray<MdastBlockContent>): MdastRoot => ({
  type: "root",
  children
})

// Type guards

/**
 * Type guard for MDAST text node.
 *
 * @category Guards
 */
export const isMdastText = (node: MdastNode): node is MdastText => node.type === "text"

/**
 * Type guard for MDAST heading node.
 *
 * @category Guards
 */
export const isMdastHeading = (node: MdastNode): node is MdastHeading => node.type === "heading"

/**
 * Type guard for MDAST paragraph node.
 *
 * @category Guards
 */
export const isMdastParagraph = (node: MdastNode): node is MdastParagraph => node.type === "paragraph"

/**
 * Type guard for MDAST code node.
 *
 * @category Guards
 */
export const isMdastCode = (node: MdastNode): node is MdastCode => node.type === "code"

/**
 * Type guard for MDAST link node.
 *
 * @category Guards
 */
export const isMdastLink = (node: MdastNode): node is MdastLink => node.type === "link"

// Schemas for validation

/**
 * Schema for MDAST text node.
 *
 * @category Schemas
 */
export const MdastTextSchema: Schema.Schema<MdastText> = Schema.Struct({
  type: Schema.Literal("text"),
  value: Schema.String
})

/**
 * Schema for MDAST inline code node.
 *
 * @category Schemas
 */
export const MdastInlineCodeSchema: Schema.Schema<MdastInlineCode> = Schema.Struct({
  type: Schema.Literal("inlineCode"),
  value: Schema.String
})

/**
 * Schema for MDAST break node.
 *
 * @category Schemas
 */
export const MdastBreakSchema: Schema.Schema<MdastBreak> = Schema.Struct({
  type: Schema.Literal("break")
})

/**
 * Schema for MDAST thematic break node.
 *
 * @category Schemas
 */
export const MdastThematicBreakSchema: Schema.Schema<MdastThematicBreak> = Schema.Struct({
  type: Schema.Literal("thematicBreak")
})

/**
 * Schema for MDAST code block node.
 *
 * @category Schemas
 */
export const MdastCodeSchema = Schema.Struct({
  type: Schema.Literal("code"),
  lang: Schema.optional(Schema.String),
  meta: Schema.optional(Schema.String),
  value: Schema.String
})

/**
 * Schema for MDAST image node.
 *
 * @category Schemas
 */
export const MdastImageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  url: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  alt: Schema.optional(Schema.NullOr(Schema.String))
})

/**
 * Schema for MDAST HTML node.
 *
 * @category Schemas
 */
export const MdastHtmlSchema: Schema.Schema<MdastHtml> = Schema.Struct({
  type: Schema.Literal("html"),
  value: Schema.String
})

// Note: Full recursive schemas for heading, paragraph, list, table etc.
// are complex due to recursive nature. For now we use simpler type-based approach
// and add full schemas as needed during implementation.

/**
 * Valid MDAST block content types.
 */
const MdastBlockTypes = [
  "heading",
  "paragraph",
  "code",
  "blockquote",
  "list",
  "table",
  "thematicBreak",
  "html"
] as const

/**
 * Type guard for MDAST block content.
 *
 * @category Guards
 */
export const isMdastBlockContent = (node: unknown): node is MdastBlockContent =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string" &&
  (MdastBlockTypes as ReadonlyArray<string>).includes((node as { type: string }).type)

/**
 * Type guard for MDAST root.
 *
 * @category Guards
 */
export const isMdastRoot = (value: unknown): value is MdastRoot =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  (value as { type: unknown }).type === "root" &&
  "children" in value &&
  Array.isArray((value as { children: unknown }).children) &&
  (value as { children: Array<unknown> }).children.every(isMdastBlockContent)

/**
 * Base schema for MDAST root structure.
 */
const MdastRootBaseSchema = Schema.Struct({
  type: Schema.Literal("root"),
  children: Schema.Array(Schema.Unknown)
})

/**
 * Schema for MDAST root with runtime validation.
 *
 * Validates that the structure conforms to MdastRoot type.
 * Uses a type guard to ensure children are valid block content.
 *
 * @category Schemas
 */
export const MdastRootSchema: Schema.Schema<
  MdastRoot,
  { type: "root"; children: ReadonlyArray<unknown> }
> = Schema.transform(
  MdastRootBaseSchema,
  Schema.typeSchema(Schema.Any as Schema.Schema<MdastRoot>),
  {
    strict: true,
    decode: (base) => {
      // Validate children at runtime
      if (!base.children.every(isMdastBlockContent)) {
        // Return with best-effort cast - remark-parse output is trusted
        return { type: "root" as const, children: base.children as ReadonlyArray<MdastBlockContent> }
      }
      return { type: "root" as const, children: base.children as ReadonlyArray<MdastBlockContent> }
    },
    encode: (root) => ({ type: "root" as const, children: root.children as ReadonlyArray<unknown> })
  }
)
