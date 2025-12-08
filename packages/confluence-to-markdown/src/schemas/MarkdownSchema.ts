/**
 * Bi-directional schema for Markdown <-> AST transformation.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import type { Document } from "../ast/Document.js"
import { parseMarkdown } from "../parsers/MarkdownParser.js"
import { serializeToMarkdown } from "../serializers/MarkdownSerializer.js"

/**
 * Schema.Type placeholder for Document to use with transformOrFail.
 * We use Schema.Any since Document is already a union type.
 */
const DocumentSchema = Schema.Any as Schema.Schema<Document, Document>

/**
 * Bi-directional schema: Markdown string <-> Document AST.
 *
 * @example
 * ```typescript
 * import { DocumentFromMarkdown } from "@knpkv/confluence-to-markdown/schemas/MarkdownSchema"
 * import { Schema, Effect } from "effect"
 *
 * // Decode: Markdown -> AST
 * const decodeResult = Schema.decodeUnknown(DocumentFromMarkdown)(markdownString)
 *
 * // Encode: AST -> Markdown
 * const encodeResult = Schema.encode(DocumentFromMarkdown)(document)
 * ```
 *
 * @category Schemas
 */
export const DocumentFromMarkdown: Schema.Schema<
  Document,
  string,
  never
> = Schema.transformOrFail(
  Schema.String,
  DocumentSchema,
  {
    strict: true,
    decode: (md, _opts, ast) =>
      Effect.mapError(
        parseMarkdown(md),
        (err) => new ParseResult.Type(ast, md, err.message)
      ),
    encode: (doc, _opts, ast) =>
      Effect.mapError(
        serializeToMarkdown(doc),
        (err) => new ParseResult.Type(ast, doc, err.message)
      )
  }
)
