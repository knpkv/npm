/**
 * Document AST node - the root of the AST tree.
 *
 * @module
 */
import * as Schema from "effect/Schema"
import { BlockNode, type BlockNode as BlockNodeType, RawConfluence, SchemaVersion } from "./BlockNode.js"
import { MacroNode, type MacroNode as MacroNodeType } from "./MacroNode.js"

/**
 * Document node - represents a Block or Macro node.
 *
 * @category Document
 */
export const DocumentNode = Schema.Union(BlockNode, MacroNode)

/**
 * Type for document nodes.
 *
 * @category Types
 */
export type DocumentNode = BlockNodeType | MacroNodeType

/**
 * Document schema - the root AST node.
 *
 * @example
 * ```typescript
 * import { Document, Heading, Paragraph, Text } from "@knpkv/confluence-to-markdown/ast"
 * import * as Schema from "effect/Schema"
 *
 * const doc = {
 *   version: 1,
 *   children: [
 *     new Heading({ level: 1, children: [new Text({ value: "Title" })] }),
 *     new Paragraph({ children: [new Text({ value: "Content" })] })
 *   ]
 * }
 *
 * const validated = Schema.decodeUnknownSync(Document)(doc)
 * ```
 *
 * @category Document
 */
export const Document = Schema.Struct({
  version: SchemaVersion,
  children: Schema.Array(DocumentNode),
  rawConfluence: RawConfluence
})

/**
 * Type for Document.
 *
 * @category Types
 */
export type Document = Schema.Schema.Type<typeof Document>

/**
 * Create a new Document with default version.
 *
 * @example
 * ```typescript
 * import { makeDocument, Heading, Text } from "@knpkv/confluence-to-markdown/ast"
 *
 * const doc = makeDocument([
 *   new Heading({ level: 1, children: [new Text({ value: "Hello" })] })
 * ])
 * ```
 *
 * @category Constructors
 */
export const makeDocument = (
  children: ReadonlyArray<DocumentNode>,
  rawConfluence?: string
): Document => ({
  version: 1,
  children,
  ...(rawConfluence !== undefined ? { rawConfluence } : {})
})

/**
 * Check if a node is a Document.
 *
 * @category Guards
 */
export const isDocument = (value: unknown): value is Document =>
  typeof value === "object" &&
  value !== null &&
  "children" in value &&
  Array.isArray((value as Document).children)
