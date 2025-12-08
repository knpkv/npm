/**
 * HTML to Markdown conversion service using AST-based approach.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { Document } from "./ast/Document.js"
import { ConversionError } from "./ConfluenceError.js"
import { parseConfluenceHtml } from "./parsers/ConfluenceParser.js"
import { parseMarkdown } from "./parsers/MarkdownParser.js"
import { ParseError, type SerializeError } from "./SchemaConverterError.js"
import { ConfluenceToMarkdown, DocumentFromHast, DocumentFromMdast } from "./schemas/ConversionSchema.js"
import { HastFromHtml } from "./schemas/hast/index.js"
import { MdastFromMarkdown } from "./schemas/mdast/index.js"
import { PreprocessedHtmlFromConfluence } from "./schemas/preprocessing/index.js"
import { serializeToConfluence } from "./serializers/ConfluenceSerializer.js"
import { type SerializeOptions, serializeToMarkdown } from "./serializers/MarkdownSerializer.js"

/**
 * Markdown conversion service for HTML <-> GFM conversion.
 *
 * @example
 * ```typescript
 * import { MarkdownConverter } from "@knpkv/confluence-to-markdown/MarkdownConverter"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const converter = yield* MarkdownConverter
 *   const md = yield* converter.htmlToMarkdown("<h1>Hello</h1><p>World</p>")
 *   console.log(md) // # Hello\n\nWorld
 * })
 *
 * Effect.runPromise(
 *   program.pipe(Effect.provide(MarkdownConverter.layer))
 * )
 * ```
 *
 * @category Conversion
 */
export class MarkdownConverter extends Context.Tag(
  "@knpkv/confluence-to-markdown/MarkdownConverter"
)<
  MarkdownConverter,
  {
    /**
     * Convert Confluence storage format (HTML) to GitHub Flavored Markdown.
     */
    readonly htmlToMarkdown: (
      html: string,
      options?: SerializeOptions
    ) => Effect.Effect<string, ConversionError>

    /**
     * Convert GitHub Flavored Markdown to HTML (Confluence storage format).
     */
    readonly markdownToHtml: (markdown: string) => Effect.Effect<string, ConversionError>

    /**
     * Parse Confluence HTML to Document AST.
     */
    readonly htmlToAst: (html: string) => Effect.Effect<Document, ParseError>

    /**
     * Parse Markdown to Document AST.
     */
    readonly markdownToAst: (markdown: string) => Effect.Effect<Document, ParseError>

    /**
     * Serialize Document AST to Confluence HTML.
     */
    readonly astToHtml: (doc: Document) => Effect.Effect<string, SerializeError>

    /**
     * Serialize Document AST to Markdown.
     */
    readonly astToMarkdown: (doc: Document) => Effect.Effect<string, SerializeError>
  }
>() {}

/**
 * Layer that provides the MarkdownConverter service.
 *
 * @category Layers
 */
export const layer: Layer.Layer<MarkdownConverter> = Layer.succeed(
  MarkdownConverter,
  MarkdownConverter.of({
    htmlToMarkdown: (html, options) =>
      Effect.gen(function*() {
        // Use AST-based approach to preserve colors, underlines, etc.
        const doc = yield* parseConfluenceHtml(html).pipe(
          Effect.mapError((e) => new ConversionError({ direction: "htmlToMarkdown", cause: e.message }))
        )
        return yield* serializeToMarkdown(doc, options).pipe(
          Effect.mapError((e) => new ConversionError({ direction: "htmlToMarkdown", cause: e.message }))
        )
      }),

    markdownToHtml: (markdown) =>
      Effect.gen(function*() {
        // Use AST-based approach for consistency
        const doc = yield* parseMarkdown(markdown).pipe(
          Effect.mapError((e) => new ConversionError({ direction: "markdownToHtml", cause: e.message }))
        )
        return yield* serializeToConfluence(doc).pipe(
          Effect.mapError((e) => new ConversionError({ direction: "markdownToHtml", cause: e.message }))
        )
      }),

    htmlToAst: (html) => parseConfluenceHtml(html),

    markdownToAst: (markdown) => parseMarkdown(markdown),

    astToHtml: (doc) => serializeToConfluence(doc),

    astToMarkdown: (doc) => serializeToMarkdown(doc)
  })
)

/**
 * Schema-based layer for MarkdownConverter using Effect Schema transforms.
 *
 * This is an alternative implementation that uses the new Schema-based
 * conversion pipeline. It provides the same API as the default layer.
 *
 * Note: For full fidelity, continue to use the default layer. This schema-based
 * layer is useful for simpler use cases or when you want to leverage Schema
 * composition.
 *
 * @example
 * ```typescript
 * import { MarkdownConverter, schemaBasedLayer } from "@knpkv/confluence-to-markdown/MarkdownConverter"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const converter = yield* MarkdownConverter
 *   const md = yield* converter.htmlToMarkdown("<h1>Hello</h1>")
 * })
 *
 * Effect.runPromise(
 *   program.pipe(Effect.provide(schemaBasedLayer))
 * )
 * ```
 *
 * @category Layers
 */
export const schemaBasedLayer: Layer.Layer<MarkdownConverter> = Layer.succeed(
  MarkdownConverter,
  MarkdownConverter.of({
    // Note: Schema-based layer doesn't support includeRawSource option yet
    htmlToMarkdown: (html, _options) =>
      Schema.decode(ConfluenceToMarkdown)(html).pipe(
        Effect.mapError((e) => new ConversionError({ direction: "htmlToMarkdown", cause: e.message }))
      ),

    markdownToHtml: (markdown) =>
      Schema.encode(ConfluenceToMarkdown)(markdown).pipe(
        Effect.mapError((e) => new ConversionError({ direction: "markdownToHtml", cause: e.message }))
      ),

    htmlToAst: (html) =>
      Effect.gen(function*() {
        const preprocessed = yield* Schema.decode(PreprocessedHtmlFromConfluence)(html)
        const hast = yield* Schema.decode(HastFromHtml)(preprocessed)
        return yield* Schema.decode(DocumentFromHast)(hast)
      }).pipe(
        Effect.mapError((e) => new ParseError({ source: "confluence", message: e.message }))
      ),

    markdownToAst: (markdown) =>
      Effect.gen(function*() {
        const mdast = yield* Schema.decode(MdastFromMarkdown)(markdown)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return yield* Schema.decode(DocumentFromMdast)(mdast as any)
      }).pipe(
        Effect.mapError((e) => new ParseError({ source: "markdown", message: e.message }))
      ),

    // For serialization, continue using the existing serializers for full fidelity
    astToHtml: (doc) => serializeToConfluence(doc),

    astToMarkdown: (doc) => serializeToMarkdown(doc)
  })
)
