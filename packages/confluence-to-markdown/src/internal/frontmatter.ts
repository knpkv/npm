/**
 * Front-matter parsing and serialization utilities.
 *
 * @module
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as yaml from "js-yaml"
import { FrontMatterError } from "../ConfluenceError.js"
import type { NewPageFrontMatter, PageFrontMatter } from "../Schemas.js"
import { NewPageFrontMatterSchema, PageFrontMatterSchema } from "../Schemas.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * Parsed markdown file with front-matter.
 */
export interface ParsedMarkdown {
  readonly frontMatter: PageFrontMatter | NewPageFrontMatter | null
  readonly content: string
  readonly isNew: boolean
}

const parseRawMarkdown = (content: string): { readonly data: Record<string, unknown>; readonly content: string } => {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { data: {}, content }
  }

  const newline = content.startsWith("---\r\n") ? "\r\n" : "\n"
  const headerStart = 3 + newline.length
  const closingMarker = `${newline}---`
  const closingStart = content.indexOf(closingMarker, headerStart)
  if (closingStart === -1) {
    return { data: {}, content }
  }

  const header = content.slice(headerStart, closingStart)
  const afterClosingStart = closingStart + closingMarker.length
  const afterClosing = content.startsWith("\r\n", afterClosingStart)
    ? content.slice(afterClosingStart + 2)
    : content.startsWith("\n", afterClosingStart)
    ? content.slice(afterClosingStart + 1)
    : content.slice(afterClosingStart)
  const loaded = yaml.load(header)
  const data = isRecord(loaded) ? loaded : {}
  return { data, content: afterClosing }
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
      try: () => parseRawMarkdown(content),
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
    const existingResult = yield* Schema.decodeUnknownEffect(PageFrontMatterSchema)(parsed.data).pipe(
      Effect.map((fm) => ({
        frontMatter: fm,
        content: parsed.content.trim(),
        isNew: false
      })),
      Effect.catchCause(() =>
        // Try to parse as new page front-matter
        Schema.decodeUnknownEffect(NewPageFrontMatterSchema)(parsed.data).pipe(
          Effect.map((fm) => ({
            frontMatter: fm,
            content: parsed.content.trim(),
            isNew: true
          })),
          Effect.catchCause((cause) => Effect.fail(new FrontMatterError({ path: filePath, cause })))
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

  return stringifyFrontmatter(content, fm)
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

  return stringifyFrontmatter(content, fm)
}

const stringifyFrontmatter = (content: string, frontMatter: Record<string, unknown>): string => {
  const header = yaml.dump(frontMatter, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  }).trimEnd()
  const body = content.endsWith("\n") ? content : `${content}\n`
  return `---\n${header}\n---\n${body}`
}
