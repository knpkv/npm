/** Read-only ADF conversion that cannot carry raw HTML or active destinations. @module */
import type { MarkdownConverter } from "@knpkv/confluence-to-markdown"
import * as Effect from "effect/Effect"

import { PluginMalformedResponseFailure } from "../failures.js"

const MAXIMUM_SAFE_MARKDOWN_CHARACTERS = 262_144
const ADF_METADATA = /<!--\s*adf:[\s\S]*?-->/gu
const GENERATED_IMAGE = /!\[([^\]]*)\]\((?:<[^>\n]*>|[^)\n]*)\)/gu
const GENERATED_LINK = /\[([^\]]*)\]\((?:<[^>\n]*>|[^)\n]*)\)/gu
const RAW_HTML = /<[^>\n]*>/gu
const ACTIVE_DESTINATION = /\b(?:data|file|https?|javascript):[^\s)]*/giu

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
  const safe = markdown
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
    .trim()
  if (safe.length > MAXIMUM_SAFE_MARKDOWN_CHARACTERS) {
    return yield* new PluginMalformedResponseFailure({
      operation: "confluence-content-conversion",
      diagnosticCode: "confluence-content-too-large"
    })
  }
  return safe.length === 0 ? "" : `${safe}\n`
})
