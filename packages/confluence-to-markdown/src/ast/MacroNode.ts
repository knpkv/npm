/**
 * Confluence macro AST node types.
 *
 * @module
 */
import * as Schema from "effect/Schema"
import {
  CodeBlock,
  Heading,
  Image,
  Paragraph,
  RawConfluence,
  SchemaVersion,
  Table,
  ThematicBreak,
  UnsupportedBlock
} from "./BlockNode.js"

// Reuse SimpleBlockNode for macro children
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
 * Supported panel type names.
 * Single source of truth for all panel macros.
 *
 * @category MacroNode
 */
export const PanelTypes = ["info", "warning", "note", "tip", "error", "panel"] as const

/**
 * Panel type for info/warning/note macros.
 *
 * @category MacroNode
 */
export const PanelType = Schema.Literal(...PanelTypes)

/**
 * Type for panel type.
 *
 * @category Types
 */
export type PanelType = Schema.Schema.Type<typeof PanelType>

/**
 * Info/Warning/Note panel macro.
 *
 * Represents Confluence info, warning, note, tip, and error panels.
 * In Markdown, rendered as `:::info`, `:::warning`, etc. container syntax.
 *
 * @example
 * ```typescript
 * import { InfoPanel, Paragraph, Text } from "@knpkv/confluence-to-markdown/ast"
 *
 * const panel = {
 *   _tag: "InfoPanel" as const,
 *   panelType: "warning" as const,
 *   title: "Important",
 *   children: [new Paragraph({ children: [new Text({ value: "Be careful!" })] })]
 * }
 * ```
 *
 * @category MacroNode
 */
export const InfoPanel = Schema.Struct({
  _tag: Schema.Literal("InfoPanel"),
  version: SchemaVersion,
  panelType: PanelType,
  title: Schema.optional(Schema.String),
  children: Schema.Array(SimpleBlockNode),
  rawConfluence: RawConfluence
})

/**
 * Type for InfoPanel.
 *
 * @category Types
 */
export type InfoPanel = Schema.Schema.Type<typeof InfoPanel>

/**
 * Expand/collapse macro.
 *
 * Represents Confluence expand macro for collapsible content.
 * In Markdown, rendered as `:::details` container syntax.
 *
 * @example
 * ```typescript
 * import { ExpandMacro, Paragraph, Text } from "@knpkv/confluence-to-markdown/ast"
 *
 * const expand = {
 *   _tag: "ExpandMacro" as const,
 *   title: "Click to expand",
 *   children: [new Paragraph({ children: [new Text({ value: "Hidden content" })] })]
 * }
 * ```
 *
 * @category MacroNode
 */
export const ExpandMacro = Schema.Struct({
  _tag: Schema.Literal("ExpandMacro"),
  version: SchemaVersion,
  title: Schema.optional(Schema.String),
  children: Schema.Array(SimpleBlockNode),
  rawConfluence: RawConfluence
})

/**
 * Type for ExpandMacro.
 *
 * @category Types
 */
export type ExpandMacro = Schema.Schema.Type<typeof ExpandMacro>

/**
 * Table of contents macro.
 *
 * Represents Confluence TOC macro for auto-generated table of contents.
 * In Markdown, rendered as `[[toc]]` or similar marker.
 *
 * @example
 * ```typescript
 * import { TocMacro } from "@knpkv/confluence-to-markdown/ast"
 *
 * const toc = {
 *   _tag: "TocMacro" as const,
 *   minLevel: 2,
 *   maxLevel: 4
 * }
 * ```
 *
 * @category MacroNode
 */
export const TocMacro = Schema.Struct({
  _tag: Schema.Literal("TocMacro"),
  version: SchemaVersion,
  minLevel: Schema.optional(Schema.Number),
  maxLevel: Schema.optional(Schema.Number),
  rawConfluence: RawConfluence
})

/**
 * Type for TocMacro.
 *
 * @category Types
 */
export type TocMacro = Schema.Schema.Type<typeof TocMacro>

/**
 * Code macro with syntax highlighting.
 *
 * Represents Confluence code macro with language and options.
 * Different from CodeBlock in that it preserves Confluence-specific options.
 *
 * @example
 * ```typescript
 * import { CodeMacro } from "@knpkv/confluence-to-markdown/ast"
 *
 * const code = {
 *   _tag: "CodeMacro" as const,
 *   language: "typescript",
 *   title: "Example",
 *   code: "const x = 1",
 *   lineNumbers: true
 * }
 * ```
 *
 * @category MacroNode
 */
export const CodeMacro = Schema.Struct({
  _tag: Schema.Literal("CodeMacro"),
  version: SchemaVersion,
  language: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  code: Schema.String,
  lineNumbers: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  collapse: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  firstLine: Schema.optional(Schema.Number),
  rawConfluence: RawConfluence
})

/**
 * Type for CodeMacro.
 *
 * @category Types
 */
export type CodeMacro = Schema.Schema.Type<typeof CodeMacro>

/**
 * Status macro (colored label).
 *
 * @example
 * ```typescript
 * import { StatusMacro } from "@knpkv/confluence-to-markdown/ast"
 *
 * const status = {
 *   _tag: "StatusMacro" as const,
 *   text: "In Progress",
 *   color: "Blue"
 * }
 * ```
 *
 * @category MacroNode
 */
export const StatusMacro = Schema.Struct({
  _tag: Schema.Literal("StatusMacro"),
  version: SchemaVersion,
  text: Schema.String,
  color: Schema.Literal("Grey", "Red", "Yellow", "Green", "Blue"),
  rawConfluence: RawConfluence
})

/**
 * Type for StatusMacro.
 *
 * @category Types
 */
export type StatusMacro = Schema.Schema.Type<typeof StatusMacro>

/**
 * Union of all macro node types.
 *
 * @category MacroNode
 */
export const MacroNode = Schema.Union(
  InfoPanel,
  ExpandMacro,
  TocMacro,
  CodeMacro,
  StatusMacro
)

/**
 * Type for macro nodes.
 *
 * @category Types
 */
export type MacroNode = InfoPanel | ExpandMacro | TocMacro | CodeMacro | StatusMacro
