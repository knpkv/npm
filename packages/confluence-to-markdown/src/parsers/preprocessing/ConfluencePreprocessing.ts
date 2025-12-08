/**
 * Preprocessing functions for Confluence HTML.
 *
 * Converts Confluence-specific markup (ac: tags, macros, layouts) to standard HTML
 * before parsing with rehype.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import { PanelTypes } from "../../ast/MacroNode.js"
import type { ParseError } from "../../SchemaConverterError.js"

/**
 * Pre-process Confluence macros into parseable HTML.
 *
 * @category Preprocessing
 */
export const preprocessConfluenceMacros = (html: string): Effect.Effect<string, ParseError> =>
  Effect.gen(function*() {
    let result = html

    // Process layouts FIRST - before any other preprocessing to preserve raw cell content
    result = preprocessLayouts(result)

    let iterations = 0
    const maxIterations = 100

    // Process structured macros iteratively
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
      const replacement = yield* processMacro(macroContent)
      result = result.slice(0, macroStart) + replacement + result.slice(endPos)
      iterations++
    }

    // Process task lists BEFORE stripping ac: tags
    result = preprocessTaskLists(result)

    // Process images with attachments BEFORE stripping
    result = preprocessImages(result)

    // Process emoticons BEFORE stripping
    result = preprocessEmoticons(result)

    // Process user mentions BEFORE stripping
    result = preprocessUserMentions(result)

    // Process ADF extensions (decision lists) BEFORE stripping
    result = preprocessAdfExtensions(result)

    // Remove remaining ac/ri tags
    result = result
      .replace(/<ac:parameter[^>]{0,1000}>[^<]{0,10000}<\/ac:parameter>/gi, "")
      .replace(/<\/?ac:[a-z-]{1,50}[^>]{0,1000}>/gi, "")
      .replace(/<\/?ri:[a-z-]{1,50}[^>]{0,1000}\/?>/gi, "")

    return result
  })

/**
 * Preprocess task lists.
 * <ac:task-list><ac:task><ac:task-id>43</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>text</ac:task-body></ac:task></ac:task-list>
 * -> <ul data-macro="task-list"><li data-task-id="43" data-task-status="incomplete">text</li></ul>
 */
const preprocessTaskLists = (html: string): string => {
  // Process individual tasks - use a more flexible approach
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
    // Strip inner HTML tags from body
    const cleanBody = body.replace(/<[^>]+>/g, "").trim()
    return `<li data-task-id="${id}" data-task-uuid="${uuid}" data-task-status="${status}">${cleanBody}</li>`
  })
  // Wrap task-list
  result = result.replace(/<ac:task-list[^>]*>/gi, "<ul data-macro=\"task-list\">")
  result = result.replace(/<\/ac:task-list>/gi, "</ul>")
  return result
}

/**
 * Preprocess images with attachments.
 * <ac:image ac:align="center" ac:width="250"><ri:attachment ri:filename="foo.svg"/></ac:image>
 * -> <img data-attachment="foo.svg" data-align="center" data-width="250">
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
 * <ac:emoticon ac:emoji-shortname=":grinning:" ac:emoji-id="1f600" ac:emoji-fallback="😀"/>
 * -> <span data-emoji=":grinning:" data-emoji-id="1f600">😀</span>
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
 * <ac:link><ri:user ri:account-id="557058:..."/></ac:link>
 * -> <span data-user-mention="557058:..."></span>
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
 * Preprocess ADF extensions (decision lists).
 * Extracts decision items and encodes them for roundtrip.
 */
const preprocessAdfExtensions = (html: string): string => {
  // Match ADF extension blocks
  return html.replace(
    /<ac:adf-extension>([\s\S]*?)<\/ac:adf-extension>/gi,
    (_, content) => {
      // Check if it's a decision list - extract items directly from the content
      // since decision-item nodes are nested inside decision-list
      if (content.includes("type=\"decision-list\"")) {
        const items: Array<{ localId: string; state: string; content: string }> = []
        // Match decision items - use greedy match to get full content
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
          // Encode as comment for roundtrip
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
        // Convert to standard panel div format
        return `<div data-macro="${panelType}" data-title="">${innerContent}</div>`
      }
      // Unknown ADF extension - use fallback if available
      const fallbackMatch = content.match(/<ac:adf-fallback>([\s\S]*?)<\/ac:adf-fallback>/)
      if (fallbackMatch) {
        return fallbackMatch[1] ?? ""
      }
      return ""
    }
  )
}

/**
 * Preprocess layouts.
 * Strips Confluence layout wrappers but preserves structure metadata for roundtrip.
 *
 * Strategy:
 * 1. Insert cell boundary markers (<!--cf:cell:N-->) to track which content belongs to which cell
 * 2. Insert section start markers (<!--cf:section:type;breakoutMode;breakoutWidth;cellCount-->)
 * 3. Insert layout start/end markers
 * 4. Let content parse normally - markdown remains readable
 *
 * Note: We wrap markers in <div> to ensure they're at root level after parsing.
 */
const preprocessLayouts = (html: string): string => {
  // Match entire ac:layout blocks
  return html.replace(
    /<ac:layout>([\s\S]*?)<\/ac:layout>/gi,
    (_, layoutContent) => {
      // Use divs to ensure markers are at root level after parsing
      let result = "<div data-cf-marker><!--cf:layout-start--></div>"
      let sectionIndex = 0

      // Extract layout sections
      const sectionRegex = /<ac:layout-section([^>]*)>([\s\S]*?)<\/ac:layout-section>/gi
      let sectionMatch
      while ((sectionMatch = sectionRegex.exec(layoutContent)) !== null) {
        const sectionAttrs = sectionMatch[1] ?? ""
        const sectionContent = sectionMatch[2] ?? ""

        // Extract section type
        const typeMatch = sectionAttrs.match(/ac:type="([^"]*)"/)
        const sectionType = typeMatch?.[1] ?? "fixed-width"

        // Extract breakout attributes
        const breakoutModeMatch = sectionAttrs.match(/ac:breakout-mode="([^"]*)"/)
        const breakoutWidthMatch = sectionAttrs.match(/ac:breakout-width="([^"]*)"/)
        const breakoutMode = breakoutModeMatch?.[1] ?? ""
        const breakoutWidth = breakoutWidthMatch?.[1] ?? ""

        // Count and extract cells
        const cellContents: Array<string> = []
        const cellRegex = /<ac:layout-cell[^>]*>([\s\S]*?)<\/ac:layout-cell>/gi
        let cellMatch
        while ((cellMatch = cellRegex.exec(sectionContent)) !== null) {
          cellContents.push(cellMatch[1] ?? "")
        }

        // Add section marker with metadata (wrapped in div)
        result += `<div data-cf-marker><!--cf:section:${sectionIndex};${encodeURIComponent(sectionType)};${
          encodeURIComponent(breakoutMode)
        };${encodeURIComponent(breakoutWidth)};${cellContents.length}--></div>`

        // Add cell markers and content (wrapped in divs)
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
 * Process a single Confluence macro to HTML.
 */
const processMacro = (macroContent: string): Effect.Effect<string, never> =>
  Effect.succeed((() => {
    // Extract macro name
    const nameMatch = macroContent.match(/ac:name="([^"]+)"/)
    const macroName = nameMatch?.[1] ?? ""

    // Extract plain-text body (for code macros)
    const plainBodyStart = macroContent.indexOf("<ac:plain-text-body><![CDATA[")
    const plainBodyEnd = macroContent.indexOf("]]></ac:plain-text-body>")
    if (plainBodyStart !== -1 && plainBodyEnd !== -1) {
      const content = macroContent.slice(plainBodyStart + 29, plainBodyEnd)
      const langMatch = macroContent.match(/ac:name="code".*?<ac:parameter[^>]*ac:name="language"[^>]*>([^<]+)/)
      const language = langMatch?.[1] ?? ""
      return `<pre data-macro="code" data-language="${language}"><code>${escapeHtml(content)}</code></pre>`
    }

    // Extract rich-text body
    const richBodyStart = macroContent.indexOf("<ac:rich-text-body>")
    const richBodyEnd = macroContent.indexOf("</ac:rich-text-body>")
    if (richBodyStart !== -1 && richBodyEnd !== -1) {
      const content = macroContent.slice(richBodyStart + 19, richBodyEnd)

      // Info/warning/note/panel panels
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
      return `<span data-macro="status" data-color="${colorMatch?.[1] ?? ""}">${
        escapeHtml(titleMatch?.[1] ?? "")
      }</span>`
    }

    // Unknown macro - preserve as unsupported
    return `<div data-unsupported-macro="${macroName}">${macroContent}</div>`
  })())

/**
 * Escape HTML special characters.
 *
 * @category Utilities
 */
export const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
