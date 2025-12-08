/**
 * Schema transformation from HTML string to HAST (Hypertext Abstract Syntax Tree).
 *
 * Uses rehype-parse for HTML parsing and wraps the result in Effect Schema types.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import rehypeParse from "rehype-parse"
import rehypeStringify from "rehype-stringify"
import { unified } from "unified"
import type { HastNode, HastRoot } from "./HastSchema.js"
import {
  HastRootSchema,
  makeHastComment,
  makeHastDoctype,
  makeHastElement,
  makeHastRoot,
  makeHastText
} from "./HastSchema.js"

// Unist/Hast types from rehype-parse (simplified)
interface UnistNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: Array<UnistNode>
}

interface UnistRoot {
  type: "root"
  children: Array<UnistNode>
}

/**
 * Convert unist node from rehype-parse to our HastNode type.
 */
const convertToHastNode = (node: UnistNode): HastNode => {
  switch (node.type) {
    case "text":
      return makeHastText(node.value ?? "")
    case "comment":
      return makeHastComment(node.value ?? "")
    case "doctype":
      return makeHastDoctype()
    case "element":
      return makeHastElement(
        node.tagName ?? "div",
        node.properties ?? {},
        (node.children ?? []).map(convertToHastNode)
      )
    default:
      // Unknown node type - treat as comment to preserve
      return makeHastComment(`unknown:${node.type}`)
  }
}

/**
 * Convert our HastNode type back to unist format for serialization.
 */
const convertFromHastNode = (node: HastNode): UnistNode => {
  switch (node._tag) {
    case "text":
      return { type: "text", value: node.value }
    case "comment":
      return { type: "comment", value: node.value }
    case "doctype":
      return { type: "doctype" }
    case "element":
      return {
        type: "element",
        tagName: node.tagName,
        properties: node.properties,
        children: node.children.map(convertFromHastNode)
      }
  }
}

/**
 * Convert unist root to HastRoot.
 */
const convertToHastRoot = (root: UnistRoot): HastRoot => makeHastRoot(root.children.map(convertToHastNode))

/**
 * Convert HastRoot back to unist root for serialization.
 */
const convertFromHastRoot = (root: HastRoot): UnistRoot => ({
  type: "root",
  children: root.children.map(convertFromHastNode)
})

/**
 * Transform HTML string to HAST root.
 *
 * Uses rehype-parse to parse HTML and converts the result to our schema types.
 * Supports bidirectional transformation (decode HTML -> HAST, encode HAST -> HTML).
 *
 * @example
 * ```typescript
 * import { HastFromHtml } from "@knpkv/confluence-to-markdown/schemas/hast"
 * import * as Schema from "effect/Schema"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const hast = yield* Schema.decode(HastFromHtml)("<h1>Hello</h1><p>World</p>")
 *   console.log(hast.children.length) // 2
 *   console.log(hast.children[0]._tag) // "element"
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @category Hast
 */
export const HastFromHtml: Schema.Schema<HastRoot, string> = Schema.transformOrFail(
  Schema.String,
  HastRootSchema,
  {
    strict: true,
    decode: (html, _options, ast) =>
      Effect.try({
        try: () => {
          const result = unified()
            .use(rehypeParse, { fragment: true })
            .parse(html) as UnistRoot
          return convertToHastRoot(result)
        },
        catch: (error) =>
          new ParseResult.Type(
            ast,
            html,
            `HTML parse error: ${error instanceof Error ? error.message : String(error)}`
          )
      }),
    encode: (hast, _options, ast) =>
      Effect.try({
        try: () => {
          const unist = convertFromHastRoot(hast)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return unified().use(rehypeStringify).stringify(unist as any)
        },
        catch: (error) =>
          new ParseResult.Type(
            ast,
            hast,
            `HTML stringify error: ${error instanceof Error ? error.message : String(error)}`
          )
      })
  }
)
