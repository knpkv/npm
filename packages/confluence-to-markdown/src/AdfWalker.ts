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
// `v1\.0\.0` for ordinary version strings.
const ESCAPE_RE = /[\\`*_{}[\]()#+!<>|]/g
const escapeText = (s: string): string => s.replace(ESCAPE_RE, "\\$&")
const escapeAttr = (s: string): string => s.replace(/[\\"]/g, "\\$&")

const attrStr = (n: AdfNode, key: string): string | undefined => {
  const v = n.attrs?.[key]
  return typeof v === "string" ? v : undefined
}
const attrNum = (n: AdfNode, key: string): number | undefined => {
  const v = n.attrs?.[key]
  return typeof v === "number" ? v : undefined
}

const PANEL_MAP: Record<string, string> = {
  info: "NOTE",
  note: "TIP",
  warning: "WARNING",
  success: "TIP",
  error: "CAUTION"
}

const inline = (nodes: ReadonlyArray<AdfNode> | undefined, ctx: Ctx): string => {
  if (!nodes) return ""
  let out = ""
  for (const n of nodes) out += inlineNode(n, ctx)
  return out
}

const inlineNode = (n: AdfNode, ctx: Ctx): string => {
  switch (n.type) {
    case "text":
      return applyMarks(escapeText(n.text ?? ""), n.marks ?? [], ctx)
    case "hardBreak":
      return ctx.inTable ? "<br>" : "  \n"
    case "mention": {
      const text = attrStr(n, "text") ?? attrStr(n, "id") ?? ""
      return `@${escapeText(text)}`
    }
    case "emoji": {
      const short = attrStr(n, "shortName")
      return short ? `:${short}:` : (attrStr(n, "text") ?? "")
    }
    case "inlineCard": {
      const url = attrStr(n, "url")
      return url ? `<${url}>` : ""
    }
    case "date": {
      const ts = attrStr(n, "timestamp")
      if (!ts) return ""
      const d = new Date(Number(ts))
      return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10)
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
    default:
      ctx.warnings.push({ _tag: "UnsupportedNode", nodeType: n.type })
      return `<!-- unsupported ADF inline: ${n.type} -->`
  }
}

const applyMarks = (text: string, marks: ReadonlyArray<AdfNode>, ctx: Ctx): string => {
  let out = text
  for (const m of marks) {
    switch (m.type) {
      case "code":
        out = `\`${out}\``
        break
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
        const safeHref = /[() ]/.test(href) ? `<${href.replace(/>/g, "%3E")}>` : href
        const titlePart = title ? ` "${escapeAttr(title)}"` : ""
        out = `[${out}](${safeHref}${titlePart})`
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
      return inline(n.content, ctx)
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
    case "mediaSingle":
      return mediaSingle(n, ctx)
    case "mediaGroup":
      return mediaGroup(n, ctx)
    default:
      ctx.warnings.push({ _tag: "UnsupportedNode", nodeType: n.type })
      return `<!-- unsupported ADF node: ${n.type} -->`
  }
}

const blockquote = (content: ReadonlyArray<AdfNode> | undefined, ctx: Ctx): string => {
  const inner = (content ?? []).map((c) => block(c, ctx)).join("\n\n")
  return inner.split("\n").map((l) => (l.length === 0 ? ">" : `> ${l}`)).join("\n")
}

const codeBlock = (n: AdfNode): string => {
  const lang = attrStr(n, "language") ?? ""
  const text = (n.content ?? []).map((c) => c.text ?? "").join("")
  return "```" + lang + "\n" + text + "\n```"
}

const listItemBlocks = (item: AdfNode, ctx: Ctx): string => {
  const blocks = item.content ?? []
  const parts: Array<string> = []
  for (const b of blocks) {
    if (b.type === "paragraph") {
      parts.push(inline(b.content, ctx))
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
  return parts.join("<br>").replace(/\|/g, "\\|")
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
  return [fmt(header), fmt(separator), ...bodyRows.map(fmt)].join("\n")
}

const panel = (n: AdfNode, ctx: Ctx): string => {
  const panelType = attrStr(n, "panelType") ?? "info"
  const tag = PANEL_MAP[panelType] ?? "NOTE"
  const inner = (n.content ?? []).map((c) => block(c, ctx)).join("\n\n")
  const lines = [`[!${tag}]`, ...inner.split("\n")]
  return lines.map((l) => (l.length === 0 ? ">" : `> ${l}`)).join("\n")
}

const expand = (n: AdfNode, ctx: Ctx): string => {
  const title = attrStr(n, "title") ?? ""
  const inner = (n.content ?? []).map((c) => block(c, ctx)).join("\n\n")
  return `<details><summary>${escapeText(title)}</summary>\n\n${inner}\n\n</details>`
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
  return lines.join("\n")
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
  return lines.join("\n")
}

const renderMedia = (media: AdfNode | undefined, ctx: Ctx): string => {
  const id = (media && attrStr(media, "id")) ?? ""
  const alt = (media && attrStr(media, "alt")) ?? ""
  const url = media && attrStr(media, "url")
  if (url) return `![${alt}](${url})`
  ctx.warnings.push({ _tag: "MediaWithoutUrl", mediaId: id })
  return `<!-- adf:media id=${id} -->`
}

const mediaSingle = (n: AdfNode, ctx: Ctx): string => renderMedia((n.content ?? [])[0], ctx)

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
