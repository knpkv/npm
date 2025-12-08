/**
 * Effect Schema definitions for HAST (Hypertext Abstract Syntax Tree) nodes.
 *
 * HAST is the intermediate representation used when parsing HTML.
 * These schemas provide type-safe transformation between raw HTML and our AST.
 *
 * @module
 */
import * as Schema from "effect/Schema"

/**
 * HAST element properties type.
 *
 * @category Types
 */
export type HastProperties = Record<string, unknown>

/**
 * HAST text node type.
 *
 * @category Types
 */
export interface HastText {
  readonly _tag: "text"
  readonly value: string
}

/**
 * HAST comment node type.
 *
 * @category Types
 */
export interface HastComment {
  readonly _tag: "comment"
  readonly value: string
}

/**
 * HAST doctype node type.
 *
 * @category Types
 */
export interface HastDoctype {
  readonly _tag: "doctype"
}

/**
 * HAST element node type.
 *
 * @category Types
 */
export interface HastElement {
  readonly _tag: "element"
  readonly tagName: string
  readonly properties: HastProperties
  readonly children: ReadonlyArray<HastNode>
}

/**
 * Union of all HAST node types.
 *
 * @category Types
 */
export type HastNode = HastText | HastElement | HastComment | HastDoctype

/**
 * HAST root node type.
 *
 * @category Types
 */
export interface HastRoot {
  readonly _tag: "root"
  readonly children: ReadonlyArray<HastNode>
}

/**
 * Create a HAST text node.
 *
 * @example
 * ```typescript
 * import { makeHastText } from "@knpkv/confluence-to-markdown/schemas/hast"
 *
 * const text = makeHastText("Hello world")
 * console.log(text.value) // "Hello world"
 * ```
 *
 * @category Constructors
 */
export const makeHastText = (value: string): HastText => ({
  _tag: "text",
  value
})

/**
 * Create a HAST comment node.
 *
 * @example
 * ```typescript
 * import { makeHastComment } from "@knpkv/confluence-to-markdown/schemas/hast"
 *
 * const comment = makeHastComment("cf:layout-start")
 * ```
 *
 * @category Constructors
 */
export const makeHastComment = (value: string): HastComment => ({
  _tag: "comment",
  value
})

/**
 * Create a HAST doctype node.
 *
 * @category Constructors
 */
export const makeHastDoctype = (): HastDoctype => ({
  _tag: "doctype"
})

/**
 * Create a HAST element node.
 *
 * @example
 * ```typescript
 * import { makeHastElement, makeHastText } from "@knpkv/confluence-to-markdown/schemas/hast"
 *
 * const heading = makeHastElement("h1", { id: "title" }, [makeHastText("Hello")])
 * ```
 *
 * @category Constructors
 */
export const makeHastElement = (
  tagName: string,
  properties: HastProperties = {},
  children: ReadonlyArray<HastNode> = []
): HastElement => ({
  _tag: "element",
  tagName,
  properties,
  children
})

/**
 * Create a HAST root node.
 *
 * @example
 * ```typescript
 * import { makeHastRoot, makeHastElement, makeHastText } from "@knpkv/confluence-to-markdown/schemas/hast"
 *
 * const root = makeHastRoot([
 *   makeHastElement("p", {}, [makeHastText("Content")])
 * ])
 * ```
 *
 * @category Constructors
 */
export const makeHastRoot = (children: ReadonlyArray<HastNode>): HastRoot => ({
  _tag: "root",
  children
})

/**
 * Type guard to check if a HastNode is a HastElement.
 *
 * @category Guards
 */
export const isHastElement = (node: HastNode): node is HastElement => node._tag === "element"

/**
 * Type guard to check if a HastNode is a HastText.
 *
 * @category Guards
 */
export const isHastText = (node: HastNode): node is HastText => node._tag === "text"

/**
 * Type guard to check if a HastNode is a HastComment.
 *
 * @category Guards
 */
export const isHastComment = (node: HastNode): node is HastComment => node._tag === "comment"

/**
 * Get text content from a HastNode recursively.
 *
 * @category Utilities
 */
export const getTextContent = (node: HastNode): string => {
  if (isHastText(node)) {
    return node.value
  }
  if (isHastElement(node)) {
    return node.children.map(getTextContent).join("")
  }
  return ""
}

// Schema definitions for validation

/**
 * Schema for HAST text node.
 *
 * @category Schemas
 */
export const HastTextSchema: Schema.Schema<HastText> = Schema.Struct({
  _tag: Schema.Literal("text"),
  value: Schema.String
})

/**
 * Schema for HAST comment node.
 *
 * @category Schemas
 */
export const HastCommentSchema: Schema.Schema<HastComment> = Schema.Struct({
  _tag: Schema.Literal("comment"),
  value: Schema.String
})

/**
 * Schema for HAST doctype node.
 *
 * @category Schemas
 */
export const HastDoctypeSchema: Schema.Schema<HastDoctype> = Schema.Struct({
  _tag: Schema.Literal("doctype")
})

/**
 * Schema for HAST properties.
 *
 * @category Schemas
 */
export const HastPropertiesSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
})

// Forward reference for recursive schema
const HastNodeSchemaLazy: Schema.Schema<HastNode> = Schema.suspend(() => HastNodeSchema)

/**
 * Schema for HAST element node.
 *
 * @category Schemas
 */
export const HastElementSchema: Schema.Schema<HastElement> = Schema.Struct({
  _tag: Schema.Literal("element"),
  tagName: Schema.String,
  properties: HastPropertiesSchema,
  children: Schema.Array(HastNodeSchemaLazy)
})

/**
 * Schema for HAST node union.
 *
 * @category Schemas
 */
export const HastNodeSchema: Schema.Schema<HastNode> = Schema.Union(
  HastTextSchema,
  HastElementSchema,
  HastCommentSchema,
  HastDoctypeSchema
)

/**
 * Schema for HAST root.
 *
 * @category Schemas
 */
export const HastRootSchema: Schema.Schema<HastRoot> = Schema.Struct({
  _tag: Schema.Literal("root"),
  children: Schema.Array(HastNodeSchema)
})
