/**
 * Macro AST node types (panels, expand, TOC, etc.).
 *
 * @module
 */
import * as Schema from "effect/Schema"
import {
  CodeBlock,
  Heading,
  Image,
  Paragraph,
  RawSource,
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
 * @example
 * ```typescript
 * import { InfoPanel, Paragraph, Text } from "@knpkv/atlassian-common/ast"
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
  rawSource: RawSource
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
 * @category MacroNode
 */
export const ExpandMacro = Schema.Struct({
  _tag: Schema.Literal("ExpandMacro"),
  version: SchemaVersion,
  title: Schema.optional(Schema.String),
  children: Schema.Array(SimpleBlockNode),
  rawSource: RawSource
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
 * @category MacroNode
 */
export const TocMacro = Schema.Struct({
  _tag: Schema.Literal("TocMacro"),
  version: SchemaVersion,
  minLevel: Schema.optional(Schema.Number),
  maxLevel: Schema.optional(Schema.Number),
  rawSource: RawSource
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
  rawSource: RawSource
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
 * @category MacroNode
 */
export const StatusMacro = Schema.Struct({
  _tag: Schema.Literal("StatusMacro"),
  version: SchemaVersion,
  text: Schema.String,
  color: Schema.Literal("Grey", "Red", "Yellow", "Green", "Blue"),
  rawSource: RawSource
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
