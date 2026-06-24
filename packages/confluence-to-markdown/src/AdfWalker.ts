/**
 * Owned ADF → Markdown tree walker.
 *
 * Pure recursive descent over an ADF document's `node.type` discriminant.
 * Returns GFM markdown plus a list of warnings for lossy or unknown nodes.
 *
 * @module
 */
import type { DocNode } from "@atlaskit/adf-schema"

/**
 * Warning emitted by the walker. Surfaced via `Effect.logWarning` at the
 * facade boundary; never escalated to errors so a single weird node cannot
 * break a clone of many pages.
 */
export type WalkerWarning =
  | { readonly _tag: "UnsupportedNode"; readonly nodeType: string }
  | { readonly _tag: "LossyMark"; readonly mark: string }
  | { readonly _tag: "MediaWithoutUrl"; readonly mediaId: string }
  | {
    readonly _tag: "UnsupportedExtension"
    readonly nodeType: "extension" | "bodiedExtension" | "inlineExtension"
    readonly extensionKey: string
    readonly extensionType: string
  }

export interface WalkResult {
  readonly markdown: string
  readonly warnings: ReadonlyArray<WalkerWarning>
}

interface AdfNode {
  readonly type: string
  readonly attrs?: Record<string, unknown>
  readonly content?: ReadonlyArray<AdfNode>
  readonly text?: string
  readonly marks?: ReadonlyArray<AdfNode>
}

interface Ctx {
  readonly inTable: boolean
  readonly warnings: Array<WalkerWarning>
}

// Mid-line characters that change inline parsing in GFM. We deliberately omit
// `.` and `-` because they only carry meaning at line-start (numbered lists,
// setext rules) and escaping them mid-line produces noisy output like
// `v1\.0\.0` for ordinary version strings. Same reasoning drops `#`, `+`, `>`
// (line-start only), `(`/`)` (only meaningful right after `]`, which we
// escape), `!` (only meaningful right before `[`, ditto) and `{`/`}` (not
// special in GFM at all) — escaping those produced noise like `\(v2\)`.
const ESCAPE_RE = /[\\`*_[\]<|]/g
const escapeText = (s: string): string => s.replace(ESCAPE_RE, "\\$&")
const escapeAttr = (s: string): string => s.replace(/[\\"]/g, "\\$&")
// For text inside HTML *blocks* (`<details>`/`<summary>`): CommonMark treats
// everything up to the closing blank line as raw HTML, so backslash escapes
// would render literally — entity-escape instead.
const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
// `(`/`)`/space/`<`/`>`/`\` in a destination break `[text](url)` — wrap in
// angle brackets, percent-encoding the characters that would terminate or
// escape the wrapper itself.
const safeHref = (href: string): string =>
  /[() <>\\]/.test(href) ? `<${href.replace(/[<>\\]/g, (c) => encodeURIComponent(c))}>` : href
// Alt text is substituted rather than escaped: @atlaskit's media markdown
// plugin throws on `\[`/`\]` in alt (making the page un-pushable), and
// newlines split the construct outright.
const sanitizeAlt = (s: string): string =>
  s.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\\/g, "/").replace(/\s+/g, " ").trim()

// ESCAPE_RE deliberately skips characters that are only special at line
// start, so lines assembled from paragraph text (including after hardBreak)
// must neutralize leading block markers: ATX headings, blockquotes, list
// bullets, ordered-list markers, thematic breaks, and setext underlines.
// A superfluous escape is harmless when the line later lands mid-line
// (after a list marker etc.) — backslash before punctuation always renders
// as the bare character.
const escapeLineStart = (line: string): string => {
  if (/^(#{1,6}|[-+])(\s|$)/.test(line) || line.startsWith(">") || /^-{3,}\s*$/.test(line) || /^=+\s*$/.test(line)) {
    return "\\" + line
  }
  const ordered = /^(\d+)([.)])(\s|$)/.exec(line)?.[1]
  if (ordered) return `${ordered}\\${line.slice(ordered.length)}`
  return line
}
const escapeLineStarts = (s: string): string => s.split("\n").map(escapeLineStart).join("\n")

const attrStr = (n: AdfNode, key: string): string | undefined => {
  const v = n.attrs?.[key]
  return typeof v === "string" ? v : undefined
}
const attrNum = (n: AdfNode, key: string): number | undefined => {
  const v = n.attrs?.[key]
  return typeof v === "number" ? v : undefined
}
const attrRecord = (n: AdfNode, key: string): Record<string, unknown> | undefined => {
  const v = n.attrs?.[key]
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

// Deterministic JSON for placeholder metadata: object keys are sorted
// recursively so the same attrs always produce the same marker/sidecar data,
// no matter what order Confluence happens to serialize them in. Keeps pull →
// push → pull a byte-level fixed point (and contentHash stable).
const stableStringify = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, value]) => `${JSON.stringify(k)}:${stableStringify(value)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(v) ?? "null"
}

const inline = (nodes: ReadonlyArray<AdfNode> | undefined, ctx: Ctx): string => {
  if (!nodes) return ""
  let out = ""
  for (const n of nodes) out += inlineNode(n, ctx)
  return out
}

const inlineNode = (n: AdfNode, ctx: Ctx): string => {
  switch (n.type) {
    case "text": {
      const marks = n.marks ?? []
      const text = n.text ?? ""
      // Code spans render their content literally — backslash-escaping inside
      // backticks would emit literal backslashes, which the push side then
      // preserves verbatim, doubling them on every pull/push round-trip.
      const hasCode = marks.some((m) => m.type === "code")
      return applyMarks(hasCode ? text : escapeText(text), marks, ctx)
    }
    case "hardBreak":
      return ctx.inTable ? "<br>" : "  \n"
    case "mention": {
      // Confluence stores the mention's `text` attr with the leading `@`
      // already (e.g. "@John Doe"). Strip it so we don't emit `@@John Doe`.
      const id = attrStr(n, "id")
      const raw = attrStr(n, "text") ?? id ?? ""
      const stripped = raw.startsWith("@") ? raw.slice(1) : raw
      const display = `@${escapeText(stripped)}`
      // Encode the accountId in a custom-scheme link so the push side can
      // reconstruct a real mention node. Without `id` we can only emit plain
      // text; on push, that becomes plain text in Confluence (lossy).
      return id ? `[${display}](confluence-mention://${encodeURIComponent(id)})` : display
    }
    case "emoji": {
      return `<!-- adf:${n.type} node=${stableStringify(n)} -->`
    }
    case "inlineCard": {
      const url = cardUrl(n)
      if (!url) {
        // data-payload smart links have no URL to render — losing one must
        // at least be visible in the logs.
        ctx.warnings.push({ _tag: "UnsupportedNode", nodeType: "inlineCard" })
        return ""
      }
      const attrs = n.attrs ?? { url }
      return `<!-- adf:inlineCard attrs=${stableStringify(attrs)} -->`
    }
    case "date": {
      return `<!-- adf:${n.type} node=${stableStringify(n)} -->`
    }
    case "status": {
      const text = attrStr(n, "text") ?? ""
      const color = attrStr(n, "color") ?? "neutral"
      return `<span class="adf-status" data-color="${color}">${escapeText(text)}</span>`
    }
    case "mediaInline": {
      const id = attrStr(n, "id") ?? ""
      ctx.warnings.push({ _tag: "MediaWithoutUrl", mediaId: id })
      return `<!-- adf:media id=${id} -->`
    }
    case "inlineExtension":
      return extensionPlaceholder(n, "inlineExtension", ctx)
    default:
      ctx.warnings.push({ _tag: "UnsupportedNode", nodeType: n.type })
      return `<!-- unsupported ADF inline: ${n.type} -->`
  }
}

const extensionPlaceholder = (
  n: AdfNode,
  nodeType: "extension" | "bodiedExtension" | "inlineExtension",
  ctx: Ctx
): string => {
  const extensionKey = attrStr(n, "extensionKey") ?? ""
  const extensionType = attrStr(n, "extensionType") ?? ""
  ctx.warnings.push({ _tag: "UnsupportedExtension", nodeType, extensionKey, extensionType })
  const keyPart = extensionKey ? ` key=${extensionKey}` : ""
  const typePart = extensionType ? ` type=${extensionType}` : ""
  // key/type are repeated for human readability; `attrs` is the source of
  // truth on push — it carries the *full* attrs (parameters, localId, layout)
  // so macros survive a pull → push round-trip with their configuration.
  const attrs = n.attrs ?? {}
  const attrsPart = Object.keys(attrs).length > 0
    ? ` attrs=${stableStringify(attrs)}`
    : ""
  return `<!-- adf:${nodeType}${keyPart}${typePart}${attrsPart} -->`
}

const bodiedExtension = (n: AdfNode, ctx: Ctx): string => {
  const open = extensionPlaceholder(n, "bodiedExtension", ctx)
  // Table cells flatten newlines to <br>, which would weld the markers and
  // body into one un-revertible line — emit only the single-line marker
  // there (body dropped; the placeholder warning above covers it).
  if (ctx.inTable) return open
  // Render the body so it stays visible/editable; the end marker lets the
  // push side re-attach everything in between as the bodiedExtension's body.
  // It is emitted even for an empty body so the push side can tell "bodied
  // macro with nothing in it" apart from a legacy/corrupted open marker.
  const body = (n.content ?? []).map((c) => block(c, ctx)).join("\n\n")
  const parts = body.length > 0 ? [open, body] : [open]
  return [...parts, "<!-- adf:/bodiedExtension -->"].join("\n\n")
}

const applyMarks = (text: string, marks: ReadonlyArray<AdfNode>, ctx: Ctx): string => {
  let out = text
  for (const m of marks) {
    switch (m.type) {
      case "code": {
        // Code-span content is unescaped, so per GFM the delimiter must be a
        // backtick run longer than any run inside, space-padded when the
        // content starts/ends with a backtick (or is empty).
        const runs = out.match(/`+/g) ?? []
        const fence = "`".repeat(runs.reduce((max, r) => Math.max(max, r.length), 0) + 1)
        const pad = out === "" || out.startsWith("`") || out.endsWith("`") ? " " : ""
        out = `${fence}${pad}${out}${pad}${fence}`
        break
      }
      case "strong":
        out = `**${out}**`
        break
      case "em":
        out = `_${out}_`
        break
      case "strike":
        out = `~~${out}~~`
        break
      case "link": {
        const href = attrStr(m, "href") ?? ""
        const title = attrStr(m, "title")
        const titlePart = title ? ` "${escapeAttr(title)}"` : ""
        out = `[${out}](${safeHref(href)}${titlePart})`
        break
      }
      case "underline":
        ctx.warnings.push({ _tag: "LossyMark", mark: "underline" })
        out = `<u>${out}</u>`
        break
      case "textColor": {
        const color = attrStr(m, "color") ?? ""
        ctx.warnings.push({ _tag: "LossyMark", mark: "textColor" })
        out = `<span style="color:${color}">${out}</span>`
        break
      }
      case "backgroundColor": {
        const color = attrStr(m, "color") ?? ""
        ctx.warnings.push({ _tag: "LossyMark", mark: "backgroundColor" })
        out = `<span style="background-color:${color}">${out}</span>`
        break
      }
      case "subsup": {
        const t = attrStr(m, "type") === "sup" ? "sup" : "sub"
        out = `<${t}>${out}</${t}>`
        break
      }
      default:
        ctx.warnings.push({ _tag: "LossyMark", mark: m.type })
    }
  }
  return out
}

const indentLines = (s: string, indent: string): string =>
  s.split("\n").map((line, i) => (i === 0 ? line : indent + line)).join("\n")

const block = (n: AdfNode, ctx: Ctx): string => {
  switch (n.type) {
    case "paragraph":
      return paragraph(n, ctx)
    case "heading": {
      const level = Math.min(6, Math.max(1, attrNum(n, "level") ?? 1))
      return "#".repeat(level) + " " + inline(n.content, ctx)
    }
    case "rule":
      return "---"
    case "blockquote":
      return blockquote(n.content, ctx)
    case "codeBlock":
      return codeBlock(n)
    case "bulletList":
      return list(n, ctx, false)
    case "orderedList":
      return list(n, ctx, true)
    case "table":
      return table(n, ctx)
    case "panel":
      return panel(n, ctx)
    case "expand":
    case "nestedExpand":
      return expand(n, ctx)
    case "taskList":
      return taskList(n, ctx)
    case "decisionList":
      return decisionList(n, ctx)
    case "layoutSection":
      return layoutSection(n, ctx)
    case "layoutColumn":
      return layoutColumn(n, ctx)
    case "mediaSingle":
      return mediaSingle(n, ctx)
    case "mediaGroup":
      return mediaGroup(n, ctx)
    case "blockCard":
    case "embedCard":
      return blockCard(n, ctx)
    case "extension":
      return extensionPlaceholder(n, "extension", ctx)
    case "bodiedExtension":
      return bodiedExtension(n, ctx)
    default:
      ctx.warnings.push({ _tag: "UnsupportedNode", nodeType: n.type })
      return `<!-- unsupported ADF node: ${n.type} -->`
  }
}

const paragraph = (n: AdfNode, ctx: Ctx): string => {
  const body = escapeLineStarts(inline(n.content, ctx))
  const marks = n.marks ?? []
  if (marks.length === 0 || ctx.inTable) return body
  const marksPart = ` marks=${stableStringify(marks)}`
  return `<!-- adf:paragraph${marksPart} -->\n\n${body}\n\n<!-- adf:/paragraph -->`
}

const blockquote = (content: ReadonlyArray<AdfNode> | undefined, ctx: Ctx): string => {
  const inner = (content ?? []).map((c) => block(c, ctx)).join("\n\n")
  return inner.split("\n").map((l) => (l.length === 0 ? ">" : `> ${l}`)).join("\n")
}

const codeBlock = (n: AdfNode): string => {
  // A fence's info string may not contain backticks (CommonMark) and a
  // newline would inject lines into the code content — the editor UI uses a
  // fixed language list, but the REST API accepts arbitrary strings.
  const lang = (attrStr(n, "language") ?? "").replace(/[`\s]+/g, "")
  const text = (n.content ?? []).map((c) => c.text ?? "").join("")
  // A fixed ``` fence would be terminated early by code that itself contains
  // a triple-backtick run — use one backtick more than the longest run inside.
  const runs = text.match(/`+/g) ?? []
  const fence = "`".repeat(Math.max(3, runs.reduce((max, r) => Math.max(max, r.length), 0) + 1))
  return fence + lang + "\n" + text + "\n" + fence
}

const listItemBlocks = (item: AdfNode, ctx: Ctx): string => {
  const blocks = item.content ?? []
  const parts: Array<string> = []
  for (const b of blocks) {
    if (b.type === "paragraph") {
      // Continuation lines (after hardBreak) sit at line start once the
      // item is indented, so they need the same leading-marker escapes as
      // top-level paragraphs.
      parts.push(escapeLineStarts(inline(b.content, ctx)))
    } else {
      parts.push(block(b, ctx))
    }
  }
  return parts.join("\n\n")
}

const list = (n: AdfNode, ctx: Ctx, ordered: boolean): string => {
  const items = n.content ?? []
  const startNum = ordered ? Math.max(1, attrNum(n, "order") ?? 1) : 1
  const indent = "  "
  const inner: Array<string> = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    const marker = ordered ? `${startNum + i}. ` : "- "
    const body = listItemBlocks(item, ctx)
    inner.push(marker + indentLines(body, indent))
  }
  return inner.join("\n")
}

const tableCellInline = (cell: AdfNode, ctx: Ctx): string => {
  const cellCtx: Ctx = { ...ctx, inTable: true }
  const blocks = cell.content ?? []
  const parts: Array<string> = []
  for (const b of blocks) {
    if (b.type === "paragraph") parts.push(inline(b.content, cellCtx))
    else parts.push(block(b, cellCtx).replace(/\n/g, "<br>"))
  }
  // Escape `|` so it can't open a new column — but only pipes that aren't
  // already escaped (inline() escapes them in plain text; code spans, URLs
  // and <br>-flattened blocks don't). A pipe is escaped iff it's preceded by
  // an odd run of backslashes, so count the run rather than peek one char.
  return parts.join("<br>").replace(
    /(\\*)\|/g,
    (match, backslashes: string) => backslashes.length % 2 === 0 ? `${backslashes}\\|` : match
  )
}

const table = (n: AdfNode, ctx: Ctx): string => {
  const rows = n.content ?? []
  if (rows.length === 0) return ""
  const renderRow = (row: AdfNode): Array<string> => (row.content ?? []).map((cell) => tableCellInline(cell, ctx))
  const allRows = rows.map(renderRow)
  const colCount = Math.max(...allRows.map((r) => r.length))
  const pad = (cells: Array<string>): Array<string> => {
    const out = cells.slice()
    while (out.length < colCount) out.push("")
    return out
  }
  const firstRow = rows[0]
  const firstIsHeader = (firstRow?.content ?? []).every((c) => c.type === "tableHeader")
  const header = firstIsHeader ? pad(allRows[0] ?? []) : Array<string>(colCount).fill("")
  const separator = Array<string>(colCount).fill("---")
  const bodyRows = (firstIsHeader ? allRows.slice(1) : allRows).map(pad)
  const fmt = (cells: Array<string>): string => `| ${cells.join(" | ")} |`
  return encodedBlockNode(n, [fmt(header), fmt(separator), ...bodyRows.map(fmt)].join("\n"), ctx)
}

const panel = (n: AdfNode, ctx: Ctx): string => {
  const panelType = attrStr(n, "panelType") ?? "info"
  const attrs = n.attrs ?? { panelType }
  const attrsPart = Object.keys(attrs).length > 0 ? ` attrs=${stableStringify(attrs)}` : ""
  const open = `<!-- adf:panel type=${panelType}${attrsPart} -->`
  if (ctx.inTable) return open
  const inner = (n.content ?? []).map((c) => block(c, ctx)).join("\n\n")
  const parts = inner.length > 0 ? [open, inner] : [open]
  return [...parts, "<!-- adf:/panel -->"].join("\n\n")
}

const encodedBlockNode = (n: AdfNode, body: string, ctx: Ctx): string => {
  if (ctx.inTable) return body
  const open = `<!-- adf:${n.type} node=${stableStringify(n)} -->`
  const parts = body.length > 0 ? [open, body] : [open]
  return [...parts, `<!-- adf:/${n.type} -->`].join("\n\n")
}

const expand = (n: AdfNode, ctx: Ctx): string => {
  const title = attrStr(n, "title") ?? ""
  // At block level <details> is a CommonMark type-6 HTML block, so the title
  // needs entity escaping. Inside a table cell the flattened output becomes
  // *inline* HTML where the text between tags is still markdown — there the
  // backslash escapes are the correct (and only working) form.
  const safeTitle = ctx.inTable ? escapeText(title) : escapeHtml(title)
  const inner = (n.content ?? []).map((c) => block(c, ctx)).join("\n\n")
  if (ctx.inTable) return `<details><summary>${safeTitle}</summary>\n\n${inner}\n\n</details>`
  return encodedBlockNode(n, `${title}\n\n${inner}`, ctx)
}

const taskList = (n: AdfNode, ctx: Ctx): string => {
  const items = n.content ?? []
  const lines: Array<string> = []
  for (const item of items) {
    if (item.type !== "taskItem") {
      lines.push(block(item, ctx))
      continue
    }
    const checked = attrStr(item, "state") === "DONE" ? "x" : " "
    const text = inline(item.content, ctx)
    lines.push(`- [${checked}] ${text}`)
  }
  return encodedBlockNode(n, lines.join("\n"), ctx)
}

const decisionList = (n: AdfNode, ctx: Ctx): string => {
  const items = n.content ?? []
  const lines: Array<string> = []
  for (const item of items) {
    if (item.type !== "decisionItem") {
      lines.push(block(item, ctx))
      continue
    }
    lines.push(`- 🔘 ${inline(item.content, ctx)}`)
  }
  return encodedBlockNode(n, lines.join("\n"), ctx)
}

const layoutSection = (n: AdfNode, ctx: Ctx): string => {
  const body = (n.content ?? [])
    .map((column) => block(column, ctx))
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
  return encodedBlockNode(n, body, ctx)
}

const layoutColumn = (n: AdfNode, ctx: Ctx): string => (n.content ?? []).map((child) => block(child, ctx)).join("\n\n")

const cardUrl = (n: AdfNode): string | undefined => {
  const url = attrStr(n, "url")
  if (url) return url
  const data = attrRecord(n, "data")
  const dataUrl = data?.["url"]
  return typeof dataUrl === "string" ? dataUrl : undefined
}

const blockCard = (n: AdfNode, ctx: Ctx): string => {
  const url = cardUrl(n)
  if (!url) {
    ctx.warnings.push({ _tag: "UnsupportedNode", nodeType: n.type })
    return `<!-- unsupported ADF node: ${n.type} -->`
  }
  return encodedBlockNode(n, `<${url}>`, ctx)
}

const renderMedia = (media: AdfNode | undefined, ctx: Ctx): string => {
  const id = (media && attrStr(media, "id")) ?? ""
  const alt = (media && attrStr(media, "alt")) ?? ""
  const url = media && attrStr(media, "url")
  if (url) return `![${sanitizeAlt(alt)}](${safeHref(url)})`
  ctx.warnings.push({ _tag: "MediaWithoutUrl", mediaId: id })
  return `<!-- adf:media id=${id} -->`
}

const mediaSingle = (n: AdfNode, ctx: Ctx): string => {
  const children = n.content ?? []
  const rendered = renderMedia(children.find((c) => c.type === "media"), ctx)
  const caption = children.find((c) => c.type === "caption")
  const captionText = caption ? inline(caption.content, ctx).trim() : ""
  if (captionText.length === 0) return rendered
  // An em-marked caption already renders as `_…_`; wrapping again would make
  // `__…__` (strong). Leave captions that touch an underscore unwrapped.
  const line = captionText.startsWith("_") || captionText.endsWith("_") ? captionText : `_${captionText}_`
  return `${rendered}\n${line}`
}

const mediaGroup = (n: AdfNode, ctx: Ctx): string =>
  (n.content ?? []).map((media) => renderMedia(media, ctx)).join("\n\n")

/**
 * Walk an ADF document and emit GFM markdown. Always synchronous; warnings
 * are collected, not thrown.
 */
export const walk = (doc: DocNode): WalkResult => {
  const ctx: Ctx = { inTable: false, warnings: [] }
  const root = doc as unknown as AdfNode
  const blocks = (root.content ?? []).map((c) => block(c, ctx))
  const body = blocks.join("\n\n")
  const markdown = body.endsWith("\n") ? body : body + "\n"
  return { markdown, warnings: ctx.warnings }
}
