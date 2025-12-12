/**
 * Schema-based Confluence HTML preprocessing.
 *
 * Transforms raw Confluence storage format into parseable HTML by expanding
 * macros, converting task lists, and normalizing Confluence-specific markup.
 *
 * @module
 */
import type * as Brand from "effect/Brand"
import * as Effect from "effect/Effect"
import { pipe } from "effect/Function"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import { PanelTypes } from "../../ast/MacroNode.js"

/** Maximum HTML input size (1MB) to prevent ReDoS attacks */
const MAX_HTML_SIZE = 1024 * 1024

/**
 * Branded type for preprocessed Confluence HTML.
 *
 * @category Types
 */
export type PreprocessedHtml = string & Brand.Brand<"PreprocessedHtml">

/**
 * Schema for preprocessed HTML brand.
 *
 * @category Schemas
 */
export const PreprocessedHtmlSchema = Schema.String.pipe(
  Schema.brand("PreprocessedHtml")
)

/**
 * Transform raw Confluence HTML to preprocessed HTML.
 *
 * Applies the following transformations:
 * - Layout section extraction with markers
 * - Structured macro expansion (code, info panels, expand, TOC, status)
 * - Task list normalization
 * - Image attachment processing
 * - Emoticon conversion
 * - User mention extraction
 * - ADF extension handling
 * - Namespace stripping (ac:, ri: tags)
 *
 * @example
 * ```typescript
 * import { PreprocessedHtmlFromConfluence } from "@knpkv/confluence-to-markdown/schemas/preprocessing"
 * import * as Schema from "effect/Schema"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const html = yield* Schema.decode(PreprocessedHtmlFromConfluence)(
 *     '<ac:structured-macro ac:name="info"><ac:rich-text-body>Content</ac:rich-text-body></ac:structured-macro>'
 *   )
 *   // html contains: <div data-macro="info">Content</div>
 * })
 * ```
 *
 * @category Schemas
 */
const makePreprocessedHtml = Schema.decodeSync(PreprocessedHtmlSchema)

export const PreprocessedHtmlFromConfluence = Schema.transformOrFail(
  Schema.String,
  PreprocessedHtmlSchema,
  {
    strict: true,
    decode: (html, _options, ast) =>
      Effect.gen(function*() {
        if (html.length > MAX_HTML_SIZE) {
          return yield* Effect.fail(
            new ParseResult.Type(
              ast,
              html,
              `HTML input too large: ${html.length} bytes (max ${MAX_HTML_SIZE})`
            )
          )
        }
        return pipe(html, preprocessConfluenceHtml, makePreprocessedHtml)
      }),
    encode: (preprocessed) =>
      // Identity - branded string is already a string
      Effect.succeed(preprocessed)
  }
)

/**
 * Main preprocessing pipeline.
 */
const preprocessConfluenceHtml = (html: string): string => {
  let result = html

  // 1. Process layouts FIRST - before any other preprocessing
  result = preprocessLayouts(result)

  // 2. Process structured macros iteratively
  result = processStructuredMacros(result)

  // 3. Process task lists BEFORE stripping ac: tags
  result = preprocessTaskLists(result)

  // 4. Process images with attachments
  result = preprocessImages(result)

  // 5. Process emoticons
  result = preprocessEmoticons(result)

  // 6. Process user mentions
  result = preprocessUserMentions(result)

  // 7. Process Confluence links with link-body
  result = preprocessConfluenceLinks(result)

  // 8. Process ADF extensions (decision lists)
  result = preprocessAdfExtensions(result)

  // 9. Strip remaining ac/ri namespace tags
  result = stripNamespaces(result)

  return result
}

/**
 * Process Confluence layouts.
 * Inserts markers for roundtrip preservation.
 */
const preprocessLayouts = (html: string): string => {
  return html.replace(
    /<ac:layout>([\s\S]*?)<\/ac:layout>/gi,
    (_, layoutContent) => {
      let result = "<div data-cf-marker><!--cf:layout-start--></div>"
      let sectionIndex = 0

      const sectionRegex = /<ac:layout-section([^>]*)>([\s\S]*?)<\/ac:layout-section>/gi
      let sectionMatch
      while ((sectionMatch = sectionRegex.exec(layoutContent)) !== null) {
        const sectionAttrs = sectionMatch[1] ?? ""
        const sectionContent = sectionMatch[2] ?? ""

        const typeMatch = sectionAttrs.match(/ac:type="([^"]*)"/)
        const sectionType = typeMatch?.[1] ?? "fixed-width"

        const breakoutModeMatch = sectionAttrs.match(/ac:breakout-mode="([^"]*)"/)
        const breakoutWidthMatch = sectionAttrs.match(/ac:breakout-width="([^"]*)"/)
        const breakoutMode = breakoutModeMatch?.[1] ?? ""
        const breakoutWidth = breakoutWidthMatch?.[1] ?? ""

        const cellContents: Array<string> = []
        const cellRegex = /<ac:layout-cell[^>]*>([\s\S]*?)<\/ac:layout-cell>/gi
        let cellMatch
        while ((cellMatch = cellRegex.exec(sectionContent)) !== null) {
          cellContents.push(cellMatch[1] ?? "")
        }

        result += `<div data-cf-marker><!--cf:section:${sectionIndex};${encodeURIComponent(sectionType)};${
          encodeURIComponent(breakoutMode)
        };${encodeURIComponent(breakoutWidth)};${cellContents.length}--></div>`

        cellContents.forEach((cellContent, cellIndex) => {
          result += `<div data-cf-marker><!--cf:cell:${sectionIndex};${cellIndex}--></div>${cellContent}`
        })

        result += `<div data-cf-marker><!--cf:section-end:${sectionIndex}--></div>`
        sectionIndex++
      }

      result += "<div data-cf-marker><!--cf:layout-end--></div>"
      return result
    }
  )
}

/**
 * Process structured macros iteratively.
 */
const processStructuredMacros = (html: string): string => {
  let result = html
  let iterations = 0
  const maxIterations = 100

  while (iterations < maxIterations) {
    const macroStart = result.indexOf("<ac:structured-macro")
    if (macroStart === -1) break

    // First, find the end of the opening tag to check if self-closing
    const openingTagEnd = result.indexOf(">", macroStart)
    if (openingTagEnd === -1) break

    // Check if self-closing (ends with />)
    const isSelfClosing = result[openingTagEnd - 1] === "/"

    let endPos: number
    if (isSelfClosing) {
      // Self-closing macro: <ac:structured-macro ... />
      endPos = openingTagEnd + 1
    } else {
      // Regular macro with body: find matching closing tag
      let depth = 1
      let pos = openingTagEnd + 1
      endPos = -1

      while (pos < result.length && depth > 0) {
        if (result.slice(pos, pos + 20) === "<ac:structured-macro") {
          // Check if this nested opening is also self-closing
          const nestedEnd = result.indexOf(">", pos)
          if (nestedEnd !== -1 && result[nestedEnd - 1] === "/") {
            // Self-closing nested macro - don't change depth
            pos = nestedEnd + 1
          } else {
            depth++
            pos += 20
          }
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

      if (endPos === -1) break
    }

    const macroContent = result.slice(macroStart, endPos)
    const replacement = processSingleMacro(macroContent)
    result = result.slice(0, macroStart) + replacement + result.slice(endPos)
    iterations++
  }

  return result
}

/**
 * Process a single Confluence macro to HTML.
 */
const processSingleMacro = (macroContent: string): string => {
  const nameMatch = macroContent.match(/ac:name="([^"]+)"/)
  const macroName = nameMatch?.[1] ?? ""

  // Plain-text body (for code macros)
  const plainBodyStart = macroContent.indexOf("<ac:plain-text-body><![CDATA[")
  const plainBodyEnd = macroContent.indexOf("]]></ac:plain-text-body>")
  if (plainBodyStart !== -1 && plainBodyEnd !== -1) {
    const content = macroContent.slice(plainBodyStart + 29, plainBodyEnd)
    const langMatch = macroContent.match(/ac:name="code".*?<ac:parameter[^>]*ac:name="language"[^>]*>([^<]+)/)
    const language = langMatch?.[1] ?? ""
    return `<pre data-macro="code" data-language="${language}"><code>${escapeHtml(content)}</code></pre>`
  }

  // Rich-text body
  const richBodyStart = macroContent.indexOf("<ac:rich-text-body>")
  const richBodyEnd = macroContent.indexOf("</ac:rich-text-body>")
  if (richBodyStart !== -1 && richBodyEnd !== -1) {
    const content = macroContent.slice(richBodyStart + 19, richBodyEnd)

    // Info/warning/note panels
    if ((PanelTypes as ReadonlyArray<string>).includes(macroName)) {
      const titleMatch = macroContent.match(/<ac:parameter[^>]*ac:name="title"[^>]*>([^<]+)/)
      const title = titleMatch?.[1] ?? ""
      return `<div data-macro="${macroName}" data-title="${escapeHtml(title)}">${content}</div>`
    }

    // Expand macro
    if (macroName === "expand") {
      const titleMatch = macroContent.match(/<ac:parameter[^>]*ac:name="title"[^>]*>([^<]+)/)
      const title = titleMatch?.[1] ?? ""
      return `<details data-macro="expand"><summary>${escapeHtml(title)}</summary>${content}</details>`
    }

    return content
  }

  // TOC macro
  if (macroName === "toc") {
    const minMatch = macroContent.match(/<ac:parameter[^>]*ac:name="minLevel"[^>]*>(\d+)/)
    const maxMatch = macroContent.match(/<ac:parameter[^>]*ac:name="maxLevel"[^>]*>(\d+)/)
    return `<nav data-macro="toc" data-min="${minMatch?.[1] ?? ""}" data-max="${maxMatch?.[1] ?? ""}"></nav>`
  }

  // Status macro
  if (macroName === "status") {
    const colorMatch = macroContent.match(/<ac:parameter[^>]*ac:name="colour"[^>]*>([^<]+)/)
    const titleMatch = macroContent.match(/<ac:parameter[^>]*ac:name="title"[^>]*>([^<]+)/)
    return `<span data-macro="status" data-color="${colorMatch?.[1] ?? ""}">${escapeHtml(titleMatch?.[1] ?? "")}</span>`
  }

  // Unknown macro - preserve as unsupported
  return `<div data-unsupported-macro="${macroName}">${macroContent}</div>`
}

/**
 * Preprocess task lists.
 */
const preprocessTaskLists = (html: string): string => {
  let result = html
  const taskRegex = /<ac:task>([\s\S]*?)<\/ac:task>/gi
  result = result.replace(taskRegex, (_, taskContent) => {
    const idMatch = taskContent.match(/<ac:task-id>([^<]*)<\/ac:task-id>/)
    const uuidMatch = taskContent.match(/<ac:task-uuid>([^<]*)<\/ac:task-uuid>/)
    const statusMatch = taskContent.match(/<ac:task-status>([^<]*)<\/ac:task-status>/)
    const bodyMatch = taskContent.match(/<ac:task-body>([\s\S]*?)<\/ac:task-body>/)

    const id = idMatch?.[1] ?? ""
    const uuid = uuidMatch?.[1] ?? ""
    const status = statusMatch?.[1] ?? "incomplete"
    const body = bodyMatch?.[1] ?? ""
    const cleanBody = body.replace(/<[^>]+>/g, "").trim()
    return `<li data-task-id="${id}" data-task-uuid="${uuid}" data-task-status="${status}">${cleanBody}</li>`
  })
  result = result.replace(/<ac:task-list[^>]*>/gi, "<ul data-macro=\"task-list\">")
  result = result.replace(/<\/ac:task-list>/gi, "</ul>")
  return result
}

/**
 * Preprocess images with attachments.
 */
const preprocessImages = (html: string): string => {
  return html.replace(
    /<ac:image([^>]*)>[\s\S]*?<ri:attachment([^>]*)\/>[\s\S]*?<\/ac:image>/gi,
    (_, imageAttrs, attachmentAttrs) => {
      const filename = attachmentAttrs.match(/ri:filename="([^"]*)"/)?.[1] ?? ""
      const align = imageAttrs.match(/ac:align="([^"]*)"/)?.[1] ?? ""
      const width = imageAttrs.match(/ac:width="([^"]*)"/)?.[1] ?? ""
      const alt = imageAttrs.match(/ac:alt="([^"]*)"/)?.[1] ?? ""
      const attrs = [
        `data-attachment="${escapeHtml(filename)}"`,
        align && `data-align="${align}"`,
        width && `data-width="${width}"`,
        alt && `alt="${escapeHtml(alt)}"`
      ].filter(Boolean).join(" ")
      return `<img ${attrs}>`
    }
  )
}

/**
 * Preprocess emoticons.
 */
const preprocessEmoticons = (html: string): string => {
  return html.replace(
    /<ac:emoticon([^>]*)\/?>/gi,
    (_, attrs) => {
      const shortname = attrs.match(/ac:emoji-shortname="([^"]*)"/)?.[1] ?? ""
      const emojiId = attrs.match(/ac:emoji-id="([^"]*)"/)?.[1] ?? ""
      const fallback = attrs.match(/ac:emoji-fallback="([^"]*)"/)?.[1] ?? ""
      return `<span data-emoji="${escapeHtml(shortname)}" data-emoji-id="${emojiId}">${fallback}</span>`
    }
  )
}

/**
 * Preprocess user mentions.
 */
const preprocessUserMentions = (html: string): string => {
  return html.replace(
    /<ac:link>\s*<ri:user([^>]*)\/?>\s*<\/ac:link>/gi,
    (_, attrs) => {
      const accountId = attrs.match(/ri:account-id="([^"]*)"/)?.[1] ?? ""
      return `<span data-user-mention="${escapeHtml(accountId)}"></span>`
    }
  )
}

/**
 * Preprocess Confluence links with link-body.
 * <ac:link><ac:link-body>Link text</ac:link-body></ac:link>
 * -> <span data-confluence-link>Link text</span>
 */
const preprocessConfluenceLinks = (html: string): string => {
  return html.replace(
    /<ac:link>\s*<ac:link-body>([\s\S]*?)<\/ac:link-body>\s*<\/ac:link>/gi,
    (_, linkText) => {
      return `<span data-confluence-link>${linkText}</span>`
    }
  )
}

/**
 * Preprocess ADF extensions (decision lists).
 */
const preprocessAdfExtensions = (html: string): string => {
  return html.replace(
    /<ac:adf-extension>([\s\S]*?)<\/ac:adf-extension>/gi,
    (_, content) => {
      if (content.includes("type=\"decision-list\"")) {
        const items: Array<{ localId: string; state: string; content: string }> = []
        const itemRegex = /<ac:adf-node\s+type="decision-item">([\s\S]*?)<\/ac:adf-node>/gi
        let itemMatch
        while ((itemMatch = itemRegex.exec(content)) !== null) {
          const itemContent = itemMatch[1] ?? ""
          const localIdMatch = itemContent.match(/<ac:adf-attribute\s+key="local-id">([^<]*)<\/ac:adf-attribute>/)
          const stateMatch = itemContent.match(/<ac:adf-attribute\s+key="state">([^<]*)<\/ac:adf-attribute>/)
          const textMatch = itemContent.match(/<ac:adf-content>([^<]*)<\/ac:adf-content>/)
          items.push({
            localId: localIdMatch?.[1] ?? "",
            state: stateMatch?.[1] ?? "UNDECIDED",
            content: textMatch?.[1] ?? ""
          })
        }
        if (items.length > 0) {
          const encoded = items.map((item) =>
            `${encodeURIComponent(item.localId)};${encodeURIComponent(item.state)};${encodeURIComponent(item.content)}`
          ).join("|")
          return `<!--cf:decision:${encoded}-->`
        }
      }
      // Check if it's an ADF panel (note, info, warning, etc.)
      if (content.includes("type=\"panel\"")) {
        const panelTypeMatch = content.match(/<ac:adf-attribute\s+key="panel-type">([^<]*)<\/ac:adf-attribute>/)
        const panelType = panelTypeMatch?.[1] ?? "info"
        const contentMatch = content.match(/<ac:adf-content>([\s\S]*?)<\/ac:adf-content>/)
        const innerContent = contentMatch?.[1] ?? ""
        return `<div data-macro="${panelType}" data-title="">${innerContent}</div>`
      }
      const fallbackMatch = content.match(/<ac:adf-fallback>([\s\S]*?)<\/ac:adf-fallback>/)
      if (fallbackMatch) {
        return fallbackMatch[1] ?? ""
      }
      return ""
    }
  )
}

/**
 * Strip remaining ac/ri namespace tags.
 */
const stripNamespaces = (html: string): string => {
  return html
    .replace(/<ac:parameter[^>]{0,1000}>[^<]{0,10000}<\/ac:parameter>/gi, "")
    .replace(/<\/?ac:[a-z-]{1,50}[^>]{0,1000}>/gi, "")
    .replace(/<\/?ri:[a-z-]{1,50}[^>]{0,1000}\/?>/gi, "")
}

const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
