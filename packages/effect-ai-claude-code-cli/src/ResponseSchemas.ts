/**
 * Response schemas for Claude Code CLI JSON output parsing.
 */

import * as Schema from "effect/Schema"

/**
 * Response format with direct result field.
 *
 * @category Schemas
 */
export const ResultResponse = Schema.Struct({
  result: Schema.String
})

export type ResultResponse = Schema.Schema.Type<typeof ResultResponse>

/**
 * Response format with text field.
 *
 * @category Schemas
 */
export const TextResponse = Schema.Struct({
  text: Schema.String
})

export type TextResponse = Schema.Schema.Type<typeof TextResponse>

/**
 * Content item with text.
 *
 * @category Schemas
 */
export const TextContentItem = Schema.Struct({
  text: Schema.String
})

export type TextContentItem = Schema.Schema.Type<typeof TextContentItem>

/**
 * Response format with content array.
 *
 * @category Schemas
 */
export const ContentResponse = Schema.Struct({
  content: Schema.Array(TextContentItem).pipe(Schema.minItems(1))
})

export type ContentResponse = Schema.Schema.Type<typeof ContentResponse>

/**
 * Union of all possible JSON response formats from Claude Code CLI.
 *
 * @category Schemas

 * @example
 *   import { JsonResponse } from "@knpkv/effect-ai-claude-code-cli/ResponseSchemas"
 *
 *   const response = Schema.decodeUnknownSync(JsonResponse)({
 *     result: "Hello"
 *   })
 */
export const JsonResponse = Schema.Union(
  ResultResponse,
  ContentResponse,
  TextResponse
)

export type JsonResponse = Schema.Schema.Type<typeof JsonResponse>

/**
 * Extracts text from any JsonResponse variant.
 *
 * @category Utilities

 * @example
 *   import { extractText } from "@knpkv/effect-ai-claude-code-cli/ResponseSchemas"
 *
 *   const text = extractText({ result: "Hello" }) // "Hello"
 */
export const extractText = (response: JsonResponse): string => {
  if ("result" in response) return response.result
  if ("content" in response) return response.content[0].text
  return response.text
}
