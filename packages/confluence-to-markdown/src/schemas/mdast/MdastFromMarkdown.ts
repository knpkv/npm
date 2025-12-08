/**
 * Schema transformation from Markdown string to MDAST (Markdown Abstract Syntax Tree).
 *
 * Uses remark-parse for Markdown parsing and wraps the result in Effect Schema types.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkStringify from "remark-stringify"
import { unified } from "unified"
import type { MdastRoot } from "./MdastSchema.js"
import { makeMdastRoot, MdastRootSchema } from "./MdastSchema.js"

// Unist/Mdast types from remark-parse (simplified)
interface UnistNode {
  type: string
  value?: string
  depth?: number
  lang?: string
  url?: string
  title?: string | null
  alt?: string | null
  ordered?: boolean
  start?: number
  checked?: boolean | null
  children?: Array<UnistNode>
}

interface UnistRoot {
  type: "root"
  children: Array<UnistNode>
}

/**
 * Convert unist node from remark-parse to our MdastNode type.
 * For now, we pass through the structure since MdastNode types match unist closely.
 */
const convertToMdastRoot = (root: UnistRoot): MdastRoot =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeMdastRoot(root.children as any)

/**
 * Convert our MdastRoot type back to unist format for serialization.
 */
const convertFromMdastRoot = (root: MdastRoot): UnistRoot => ({
  type: "root",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  children: root.children as any
})

/**
 * Transform Markdown string to MDAST root.
 *
 * Uses remark-parse to parse Markdown and converts the result to our schema types.
 * Supports bidirectional transformation (decode Markdown -> MDAST, encode MDAST -> Markdown).
 *
 * @example
 * ```typescript
 * import { MdastFromMarkdown } from "@knpkv/confluence-to-markdown/schemas/mdast"
 * import * as Schema from "effect/Schema"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const mdast = yield* Schema.decode(MdastFromMarkdown)("# Hello\n\nWorld")
 *   console.log(mdast.children.length) // 2
 *   console.log(mdast.children[0].type) // "heading"
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @category Mdast
 */
export const MdastFromMarkdown = Schema.transformOrFail(
  Schema.String,
  MdastRootSchema,
  {
    strict: true,
    decode: (markdown, _options, ast) =>
      Effect.try({
        try: () => {
          const result = unified()
            .use(remarkParse)
            .use(remarkGfm)
            .parse(markdown) as UnistRoot
          return convertToMdastRoot(result)
        },
        catch: (error) =>
          new ParseResult.Type(
            ast,
            markdown,
            `Markdown parse error: ${error instanceof Error ? error.message : String(error)}`
          )
      }),
    encode: (mdast, _options, ast) =>
      Effect.try({
        try: () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const unist = convertFromMdastRoot(mdast as any)
          return unified()
            .use(remarkGfm)
            .use(remarkStringify, { bullet: "-", emphasis: "_" })
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .stringify(unist as any)
        },
        catch: (error) =>
          new ParseResult.Type(
            ast,
            mdast,
            `Markdown stringify error: ${error instanceof Error ? error.message : String(error)}`
          )
      })
  }
)
