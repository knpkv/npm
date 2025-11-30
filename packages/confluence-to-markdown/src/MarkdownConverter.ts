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

/**
 * Strip Confluence-specific macros while preserving text content.
 */
const stripConfluenceMacros = (html: string): string => {
  // Remove ac:* tags but keep inner content
  const cleaned = html
    // Remove structured macro wrappers
    .replace(/<ac:structured-macro[^>]*>[\s\S]*?<\/ac:structured-macro>/gi, (match): string => {
      // Extract plain-text-body content if present
      const bodyMatch = match.match(/<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/i)
      if (bodyMatch?.[1]) {
        return `<pre><code>${bodyMatch[1]}</code></pre>`
      }
      // Extract rich-text-body content
      const richMatch = match.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i)
      if (richMatch?.[1]) {
        return richMatch[1]
      }
      return ""
    })
    // Remove ac:parameter tags
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, "")
    // Convert ac:link to regular links
    .replace(
      /<ac:link[^>]*>[\s\S]*?<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/>[\s\S]*?<ac:plain-text-link-body><!\[CDATA\[([^\]]*)\]\]><\/ac:plain-text-link-body>[\s\S]*?<\/ac:link>/gi,
      (_match: string, title: string, text: string): string => `<a href="${title}">${text || title}</a>`
    )
    // Remove remaining ac:* and ri:* tags
    .replace(/<\/?ac:[^>]*>/gi, "")
    .replace(/<\/?ri:[^>]*\/?>/gi, "")

  return cleaned
}

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
      Effect.try({
        try: () => {
          const cleaned = stripConfluenceMacros(html)
          const result = createHtmlToMdProcessor().processSync(cleaned)
          return String(result).trim()
        },
        catch: (cause) => new ConversionError({ direction: "htmlToMarkdown", cause })
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
