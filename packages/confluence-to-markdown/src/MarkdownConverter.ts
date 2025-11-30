/**
 * HTML to Markdown conversion service using unified/remark/rehype.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import rehypeParse from "rehype-parse"
import rehypeRemark from "rehype-remark"
import rehypeStringify from "rehype-stringify"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import remarkStringify from "remark-stringify"
import { unified } from "unified"
import { ConversionError } from "./ConfluenceError.js"

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
    readonly htmlToMarkdown: (html: string) => Effect.Effect<string, ConversionError>

    /**
     * Convert GitHub Flavored Markdown to HTML (Confluence storage format).
     */
    readonly markdownToHtml: (markdown: string) => Effect.Effect<string, ConversionError>
  }
>() {}

/** Maximum HTML input size (1MB) to prevent ReDoS attacks */
const MAX_HTML_SIZE = 1024 * 1024

/**
 * Strip Confluence-specific macros while preserving text content.
 * Uses iterative approach to avoid ReDoS with nested content.
 */
const stripConfluenceMacros = (html: string): Effect.Effect<string, ConversionError> =>
  Effect.gen(function*() {
    // Limit input size to prevent ReDoS
    if (html.length > MAX_HTML_SIZE) {
      return yield* Effect.fail(
        new ConversionError({
          direction: "htmlToMarkdown",
          cause: `HTML input too large: ${html.length} bytes (max ${MAX_HTML_SIZE})`
        })
      )
    }

    let result = html

    // Process structured macros iteratively to handle nesting safely
    let iterations = 0
    const maxIterations = 100 // Prevent infinite loops

    while (iterations < maxIterations) {
      const macroStart = result.indexOf("<ac:structured-macro")
      if (macroStart === -1) break

      // Find matching closing tag by counting nesting
      let depth = 1
      let pos = macroStart + 20 // Skip past opening tag start
      let endPos = -1

      while (pos < result.length && depth > 0) {
        if (result.slice(pos, pos + 20) === "<ac:structured-macro") {
          depth++
          pos += 20
        } else if (result.slice(pos, pos + 21) === "</ac:structured-macro") {
          depth--
          if (depth === 0) {
            endPos = result.indexOf(">", pos) + 1
          }
          pos += 21
        } else {
          pos++
        }
      }

      if (endPos === -1) break // Malformed HTML, stop processing

      const macroContent = result.slice(macroStart, endPos)

      // Extract content from macro
      let replacement = ""
      const plainBodyStart = macroContent.indexOf("<ac:plain-text-body><![CDATA[")
      const plainBodyEnd = macroContent.indexOf("]]></ac:plain-text-body>")
      if (plainBodyStart !== -1 && plainBodyEnd !== -1) {
        const content = macroContent.slice(plainBodyStart + 29, plainBodyEnd)
        replacement = `<pre><code>${content}</code></pre>`
      } else {
        const richBodyStart = macroContent.indexOf("<ac:rich-text-body>")
        const richBodyEnd = macroContent.indexOf("</ac:rich-text-body>")
        if (richBodyStart !== -1 && richBodyEnd !== -1) {
          replacement = macroContent.slice(richBodyStart + 19, richBodyEnd)
        }
      }

      result = result.slice(0, macroStart) + replacement + result.slice(endPos)
      iterations++
    }

    // Remove remaining simple tags with non-greedy bounded patterns
    result = result
      .replace(/<ac:parameter[^>]{0,1000}>[^<]{0,10000}<\/ac:parameter>/gi, "")
      .replace(/<\/?ac:[a-z-]{1,50}[^>]{0,1000}>/gi, "")
      .replace(/<\/?ri:[a-z-]{1,50}[^>]{0,1000}\/?>/gi, "")

    return result
  })

/**
 * Create the markdown converter processor for HTML -> Markdown.
 */
const createHtmlToMdProcessor = () =>
  unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify)

/**
 * Create the markdown converter processor for Markdown -> HTML.
 */
const createMdToHtmlProcessor = () =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeStringify)

/**
 * Layer that provides the MarkdownConverter service.
 *
 * @category Layers
 */
export const layer: Layer.Layer<MarkdownConverter> = Layer.succeed(
  MarkdownConverter,
  MarkdownConverter.of({
    htmlToMarkdown: (html) =>
      Effect.gen(function*() {
        const cleaned = yield* stripConfluenceMacros(html)
        return yield* Effect.try({
          try: () => {
            const result = createHtmlToMdProcessor().processSync(cleaned)
            return String(result).trim()
          },
          catch: (cause) => new ConversionError({ direction: "htmlToMarkdown", cause })
        })
      }),

    markdownToHtml: (markdown) =>
      Effect.try({
        try: () => {
          const result = createMdToHtmlProcessor().processSync(markdown)
          return String(result).trim()
        },
        catch: (cause) => new ConversionError({ direction: "markdownToHtml", cause })
      })
  })
)
