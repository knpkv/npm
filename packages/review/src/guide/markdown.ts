/**
 * The markdown a section overview may use: the same subset the guides.show viewer renders
 * (paragraphs, `###`, `- ` bullets, `> [!NOTE|IMPORTANT|WARNING]` callouts, fenced code, and
 * inline bold, italic, code and links) plus one addition: a ```mermaid fence becomes a
 * diagram. Keeping to that subset means the same guide.json still exports through
 * plannotator unchanged.
 */

export const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")

const SAFE_HREF = /^(https?:\/\/|#|\.{0,2}\/|[\w./-]+$)/

/** Read one destination; balanced parentheses and escaped parentheses/backslashes belong to the URL. */
const readDestination = (
  source: string,
  start: number
): { readonly href: string; readonly next: number } | undefined => {
  let depth = 0
  let href = ""
  for (let index = start; index < source.length; index++) {
    const character = source[index] ?? ""
    if (/\s/.test(character)) return undefined
    const next = source[index + 1]
    if (character === "\\" && (next === "(" || next === ")" || next === "\\")) {
      href += next
      index++
      continue
    }
    if (character === "(") depth++
    if (character === ")") {
      if (depth === 0) return href === "" ? undefined : { href, next: index + 1 }
      depth--
    }
    href += character
  }
  return undefined
}

/** Render source tokens once; generated tags and link destinations never enter a later markup pass. */
const renderMarkup = (escaped: string, links: boolean): string => {
  const tokens =
    /\[([^\]]+)\]\(|\*\*([^*]+)\*\*|(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)|(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g
  let html = ""
  let offset = 0
  for (let match = tokens.exec(escaped); match !== null; match = tokens.exec(escaped)) {
    html += escaped.slice(offset, match.index)
    const [, label, strong, starPrefix, star, underscorePrefix, underscore] = match
    if (label !== undefined) {
      const destination = readDestination(escaped, tokens.lastIndex)
      if (destination === undefined) {
        html += match[0]
      } else {
        const content = renderMarkup(label, false)
        html += !links
          ? content
          : SAFE_HREF.test(destination.href)
          ? `<a href="${destination.href}">${content}</a>`
          : `[${content}](${escaped.slice(tokens.lastIndex, destination.next - 1)})`
        tokens.lastIndex = destination.next
      }
    } else if (strong !== undefined) {
      html += `<strong>${renderMarkup(strong, links)}</strong>`
    } else if (star !== undefined) {
      html += `${starPrefix ?? ""}<em>${renderMarkup(star, links)}</em>`
    } else if (underscore !== undefined) {
      html += `${underscorePrefix ?? ""}<em>${renderMarkup(underscore, links)}</em>`
    }
    offset = tokens.lastIndex
  }
  return html + escaped.slice(offset)
}

/** Escape source text and render inline markup. Disable links inside an existing navigation link. */
export const renderInline = (raw: string, { links = true }: { readonly links?: boolean } = {}): string => {
  let html = ""
  let offset = 0
  for (let index = 0; index < raw.length;) {
    if (raw[index] !== "`") {
      index++
      continue
    }
    let end = index
    while (raw[end] === "`") end++
    const width = end - index
    let close = end
    while (close < raw.length) {
      if (raw[close] !== "`") {
        close++
        continue
      }
      let next = close
      while (raw[next] === "`") next++
      if (next - close === width) break
      close = next
    }
    if (close === raw.length) {
      index = end
      continue
    }
    html += renderMarkup(escapeHtml(raw.slice(offset, index)), links)
    html += `<code>${escapeHtml(raw.slice(end, close))}</code>`
    offset = close + width
    index = offset
  }
  return html + renderMarkup(escapeHtml(raw.slice(offset)), links)
}

const CALLOUT = /^\[!(NOTE|IMPORTANT|WARNING)\]\s*$/

export interface Rendered {
  readonly html: string
  /** True when a mermaid fence was rendered, so the page knows to load the library. */
  readonly mermaid: boolean
}

export const renderMarkdown = (source: string): Rendered => {
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  const out: Array<string> = []
  let mermaid = false
  let index = 0

  const paragraph: Array<string> = []
  const flush = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${renderInline(paragraph.join(" "))}</p>`)
      paragraph.length = 0
    }
  }

  while (index < lines.length) {
    const line = lines[index] ?? ""

    if (line.trim() === "") {
      flush()
      index += 1
      continue
    }

    const fence = /^(`{3,})[ \t]*([^`]*)$/.exec(line)
    if (fence !== null) {
      flush()
      const delimiter = fence[1] ?? "```"
      const lang = (fence[2] ?? "").trim().split(/\s+/)[0] ?? ""
      const body: Array<string> = []
      index += 1
      while (index < lines.length) {
        const closing = /^(`{3,})[ \t]*$/.exec(lines[index] ?? "")
        if (closing !== null && (closing[1]?.length ?? 0) >= delimiter.length) break
        body.push(lines[index] ?? "")
        index += 1
      }
      index += 1 // closing fence
      if (lang === "mermaid") {
        mermaid = true
        out.push(`<pre class="mermaid">${escapeHtml(body.join("\n"))}</pre>`)
      } else {
        const token = lang.replace(/[^a-zA-Z0-9_-]/g, "-")
        const cls = token === "" ? "" : ` class="lang-${token}"`
        out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`)
      }
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flush()
      const level = Math.min(6, (heading[1]?.length ?? 3) + 1) // `###` in a section renders as h4
      out.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`)
      index += 1
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      flush()
      const items: Array<string> = []
      while (index < lines.length && /^[-*]\s+/.test(lines[index] ?? "")) {
        let item = (lines[index] ?? "").replace(/^[-*]\s+/, "")
        index += 1
        // Continuation lines indented under the bullet.
        while (
          index < lines.length && /^\s{2,}\S/.test(lines[index] ?? "") && !/^\s*[-*]\s+/.test(lines[index] ?? "")
        ) {
          item += ` ${(lines[index] ?? "").trim()}`
          index += 1
        }
        items.push(`<li>${renderInline(item)}</li>`)
      }
      out.push(`<ul>${items.join("")}</ul>`)
      continue
    }

    const orderedStart = /^(\d+)\.\s+/.exec(line)?.[1]
    if (orderedStart !== undefined) {
      flush()
      const items: Array<string> = []
      while (index < lines.length && /^\d+\.\s+/.test(lines[index] ?? "")) {
        let item = (lines[index] ?? "").replace(/^\d+\.\s+/, "")
        index += 1
        while (
          index < lines.length && /^\s{2,}\S/.test(lines[index] ?? "") &&
          !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[index] ?? "")
        ) {
          item += ` ${(lines[index] ?? "").trim()}`
          index += 1
        }
        items.push(`<li>${renderInline(item)}</li>`)
      }
      const start = orderedStart === "1" ? "" : ` start="${orderedStart}"`
      out.push(`<ol${start}>${items.join("")}</ol>`)
      continue
    }

    if (line.startsWith(">")) {
      flush()
      const quoted: Array<string> = []
      while (index < lines.length && (lines[index] ?? "").startsWith(">")) {
        quoted.push((lines[index] ?? "").replace(/^>\s?/, ""))
        index += 1
      }
      const kind = CALLOUT.exec(quoted[0] ?? "")
      if (kind !== null) {
        const label = kind[1] ?? "NOTE"
        const body = renderMarkdown(quoted.slice(1).join("\n"))
        mermaid ||= body.mermaid
        out.push(
          `<aside class="callout callout-${label.toLowerCase()}"><span class="callout-label">${label}</span>${body.html}</aside>`
        )
      } else {
        const body = renderMarkdown(quoted.join("\n"))
        mermaid ||= body.mermaid
        out.push(`<blockquote>${body.html}</blockquote>`)
      }
      continue
    }

    paragraph.push(line.trim())
    index += 1
  }
  flush()
  return { html: out.join("\n"), mermaid }
}
