/** Read-only ADF conversion that cannot carry raw HTML or active destinations. @module */
import type { MarkdownConverter } from "@knpkv/confluence-to-markdown"
import * as Effect from "effect/Effect"

import { PluginMalformedResponseFailure } from "../failures.js"

const MAXIMUM_SAFE_MARKDOWN_CHARACTERS = 262_144
const ADF_METADATA = /<!--\s*adf:[\s\S]*?-->/gu
const GENERATED_IMAGE = /!\[([^\]]*)\]\((?:<[^>\n]*>|[^)\n]*)\)/gu
const GENERATED_LINK = /\[([^\]]*)\]\((?:<[^>\n]*>|[^)\n]*)\)/gu
const RAW_HTML = /<[^>]*>/gu
const ACTIVE_DESTINATION = /\b(?:data|file|https?|javascript):[^\s)]*/giu

type MarkdownChunk = {
  readonly kind: "code" | "prose"
  readonly value: string
}

type Fence = {
  readonly character: "`" | "~"
  readonly length: number
}

const lineAt = (markdown: string, start: number) => {
  const newline = markdown.indexOf("\n", start)
  const end = newline === -1 ? markdown.length : newline
  const value = markdown.slice(start, end).replace(/\r$/u, "")
  return { end: newline === -1 ? end : end + 1, value }
}

const openingFence = (line: string): Fence | undefined => {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
  if (match === null) return undefined
  const marker = match[1]
  if (marker === undefined) return undefined
  const character = marker[0]
  if (character !== "`" && character !== "~") return undefined
  if (character === "`" && line.slice(match[0].length).includes("`")) return undefined
  return { character, length: marker.length }
}

const closesFence = (line: string, fence: Fence): boolean => {
  const candidate = line.replace(/^ {0,3}/u, "")
  let length = 0
  while (candidate[length] === fence.character) length += 1
  return length >= fence.length && /^[ \t]*$/u.test(candidate.slice(length))
}

const fencedChunks = (markdown: string): ReadonlyArray<MarkdownChunk> => {
  const chunks: Array<MarkdownChunk> = []
  let lineStart = 0
  let proseStart = 0

  while (lineStart < markdown.length) {
    const line = lineAt(markdown, lineStart)
    const fence = openingFence(line.value)
    if (fence === undefined) {
      lineStart = line.end
      continue
    }

    if (proseStart < lineStart) chunks.push({ kind: "prose", value: markdown.slice(proseStart, lineStart) })
    let fenceEnd = line.end
    let followingLine = line.end
    while (followingLine < markdown.length) {
      const candidate = lineAt(markdown, followingLine)
      fenceEnd = candidate.end
      followingLine = candidate.end
      if (closesFence(candidate.value, fence)) break
    }
    chunks.push({ kind: "code", value: markdown.slice(lineStart, fenceEnd) })
    lineStart = fenceEnd
    proseStart = fenceEnd
  }

  if (proseStart < markdown.length) chunks.push({ kind: "prose", value: markdown.slice(proseStart) })
  return chunks
}

const isEscaped = (value: string, index: number): boolean => {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) backslashes += 1
  return backslashes % 2 === 1
}

const inlineCodeChunks = (value: string): ReadonlyArray<MarkdownChunk> => {
  const chunks: Array<MarkdownChunk> = []
  let cursor = 0
  let proseStart = 0

  while (cursor < value.length) {
    const opening = value.indexOf("`", cursor)
    if (opening === -1) break
    if (isEscaped(value, opening)) {
      cursor = opening + 1
      continue
    }
    let openingEnd = opening
    while (value[openingEnd] === "`") openingEnd += 1
    const delimiter = value.slice(opening, openingEnd)
    let closing = value.indexOf(delimiter, openingEnd)
    while (
      closing !== -1 &&
      (value[closing - 1] === "`" || value[closing + delimiter.length] === "`")
    ) {
      closing = value.indexOf(delimiter, closing + 1)
    }
    if (closing === -1) {
      cursor = openingEnd
      continue
    }
    if (proseStart < opening) chunks.push({ kind: "prose", value: value.slice(proseStart, opening) })
    const codeEnd = closing + delimiter.length
    chunks.push({ kind: "code", value: value.slice(opening, codeEnd) })
    proseStart = codeEnd
    cursor = codeEnd
  }

  if (proseStart < value.length) chunks.push({ kind: "prose", value: value.slice(proseStart) })
  return chunks
}

const markdownChunks = (markdown: string): ReadonlyArray<MarkdownChunk> =>
  fencedChunks(markdown).flatMap((chunk) => chunk.kind === "code" ? [chunk] : inlineCodeChunks(chunk.value))

const sanitizeProse = (markdown: string): string =>
  markdown
    .replace(ADF_METADATA, "")
    .replace(GENERATED_IMAGE, "$1")
    .replace(GENERATED_LINK, "$1")
    .replace(RAW_HTML, "")
    .replace(ACTIVE_DESTINATION, "")
    .replaceAll("](", "]\\(")
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")

/**
 * Convert ADF through the owning package, then remove all round-trip metadata,
 * raw HTML, media, and link destinations. The result is suitable for safe copy
 * and plain Markdown presentation; navigation remains a separate trusted URL.
 *
 * @internal
 */
export const toSafeConfluenceMarkdown = Effect.fn("ConfluencePage.toSafeMarkdown")(function*(
  converter: MarkdownConverter["Service"],
  adfJson: string
) {
  const markdown = yield* converter.adfToMarkdown(adfJson).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "confluence-content-conversion",
        diagnosticCode: "confluence-adf-invalid"
      })
    )
  )
  const safe = markdownChunks(markdown)
    .map((chunk) => chunk.kind === "code" ? chunk.value : sanitizeProse(chunk.value))
    .join("")
    .trim()
  if (safe.length > MAXIMUM_SAFE_MARKDOWN_CHARACTERS) {
    return yield* new PluginMalformedResponseFailure({
      operation: "confluence-content-conversion",
      diagnosticCode: "confluence-content-too-large"
    })
  }
  return safe.length === 0 ? "" : `${safe}\n`
})
