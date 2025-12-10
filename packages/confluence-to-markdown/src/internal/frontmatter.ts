/**
 * Front-matter parsing and serialization utilities.
 *
 * @module
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import matter from "gray-matter"
import { FrontMatterError } from "../ConfluenceError.js"
import type { NewPageFrontMatter, PageFrontMatter } from "../Schemas.js"
import { NewPageFrontMatterSchema, PageFrontMatterSchema } from "../Schemas.js"

/**
 * Parsed markdown file with front-matter.
 */
export interface ParsedMarkdown {
  readonly frontMatter: PageFrontMatter | NewPageFrontMatter | null
  readonly content: string
  readonly isNew: boolean
}

/**
 * Parse a markdown file with YAML front-matter.
 *
 * @param filePath - Path to the file (for error messages)
 * @param content - The file content
 * @returns Parsed markdown with front-matter and content
 *
 * @internal
 */
export const parseMarkdown = (
  filePath: string,
  content: string
): Effect.Effect<ParsedMarkdown, FrontMatterError> =>
  Effect.gen(function*() {
    const parsed = yield* Effect.try({
      try: () => matter(content),
      catch: (cause) => new FrontMatterError({ path: filePath, cause })
    })

    // If no front-matter or empty, treat as new page
    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      return {
        frontMatter: null,
        content: parsed.content.trim(),
        isNew: true
      }
    }

    // Try to parse as existing page front-matter
    const existingResult = yield* Schema.decodeUnknown(PageFrontMatterSchema)(parsed.data).pipe(
      Effect.map((fm) => ({
        frontMatter: fm,
        content: parsed.content.trim(),
        isNew: false
      })),
      Effect.catchAll(() =>
        // Try to parse as new page front-matter
        Schema.decodeUnknown(NewPageFrontMatterSchema)(parsed.data).pipe(
          Effect.map((fm) => ({
            frontMatter: fm as NewPageFrontMatter,
            content: parsed.content.trim(),
            isNew: true
          })),
          Effect.catchAll((cause) => Effect.fail(new FrontMatterError({ path: filePath, cause })))
        )
      )
    )

    return existingResult
  })

/**
 * Serialize markdown with YAML front-matter.
 *
 * @param frontMatter - The front-matter data
 * @param content - The markdown content
 * @returns The serialized markdown file content
 *
 * @internal
 */
export const serializeMarkdown = (
  frontMatter: PageFrontMatter,
  content: string
): string => {
  const fm = {
    pageId: frontMatter.pageId,
    version: frontMatter.version,
    title: frontMatter.title,
    updated: frontMatter.updated.toISOString(),
    ...(frontMatter.parentId !== undefined ? { parentId: frontMatter.parentId } : {}),
    ...(frontMatter.position !== undefined ? { position: frontMatter.position } : {}),
    contentHash: frontMatter.contentHash
  }

  return matter.stringify(content, fm)
}

/**
 * Serialize a new page markdown with minimal front-matter.
 *
 * @param frontMatter - The new page front-matter (title only)
 * @param content - The markdown content
 * @returns The serialized markdown file content
 *
 * @internal
 */
export const serializeNewPageMarkdown = (
  frontMatter: NewPageFrontMatter,
  content: string
): string => {
  const fm = {
    title: frontMatter.title,
    ...(frontMatter.parentId !== undefined ? { parentId: frontMatter.parentId } : {})
  }

  return matter.stringify(content, fm)
}
