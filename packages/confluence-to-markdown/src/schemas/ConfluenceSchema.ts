/**
 * Bi-directional schema for Confluence HTML <-> AST transformation.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import type { Document } from "../ast/Document.js"
import { parseConfluenceHtml } from "../parsers/ConfluenceParser.js"
import { serializeToConfluence } from "../serializers/ConfluenceSerializer.js"

/**
 * Schema.Type placeholder for Document to use with transformOrFail.
 * We use Schema.Any since Document is already a union type.
 */
const DocumentSchema = Schema.Any as Schema.Schema<Document, Document>

/**
 * Bi-directional schema: Confluence HTML string <-> Document AST.
 *
 * @example
 * ```typescript
 * import { DocumentFromConfluence } from "@knpkv/confluence-to-markdown/schemas/ConfluenceSchema"
 * import { Schema, Effect } from "effect"
 *
 * // Decode: HTML -> AST
 * const decodeResult = Schema.decodeUnknown(DocumentFromConfluence)(htmlString)
 *
 * // Encode: AST -> HTML
 * const encodeResult = Schema.encode(DocumentFromConfluence)(document)
 * ```
 *
 * @category Schemas
 */
export const DocumentFromConfluence: Schema.Schema<
  Document,
  string,
  never
> = Schema.transformOrFail(
  Schema.String,
  DocumentSchema,
  {
    strict: true,
    decode: (html, _opts, ast) =>
      Effect.mapError(
        parseConfluenceHtml(html),
        (err) => new ParseResult.Type(ast, html, err.message)
      ),
    encode: (doc, _opts, ast) =>
      Effect.mapError(
        serializeToConfluence(doc),
        (err) => new ParseResult.Type(ast, doc, err.message)
      )
  }
)
