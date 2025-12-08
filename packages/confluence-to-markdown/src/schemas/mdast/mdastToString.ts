/**
 * Utility for converting MDAST nodes to Markdown strings.
 *
 * @module
 */
import type {
  MdastBlockContent,
  MdastList,
  MdastListItem,
  MdastPhrasingContent,
  MdastTable,
  MdastTableCell,
  MdastTableRow
} from "./MdastSchema.js"

const exhaustive = (_: never): never => {
  throw new Error("Exhaustive check failed")
}

/**
 * Convert MDAST table to Markdown string.
 */
const tableToString = (table: MdastTable): string => {
  if (!table.children.length) return ""
  const headerRow = table.children[0] as MdastTableRow
  if (!headerRow) return ""
  const headerCells = headerRow.children as ReadonlyArray<MdastTableCell>
  const header = "| " + headerCells.map((cell) => cell.children.map(phrasingToString).join("")).join(" | ") + " |"
  const separator = "| " + headerCells.map(() => "---").join(" | ") + " |"
  const rows = table.children.slice(1).map((row) => {
    const cells = (row as MdastTableRow).children as ReadonlyArray<MdastTableCell>
    return "| " + cells.map((cell) => cell.children.map(phrasingToString).join("")).join(" | ") + " |"
  })
  return [header, separator, ...rows].join("\n")
}

/**
 * Convert MDAST list to Markdown string.
 */
const listToString = (list: MdastList): string =>
  list.children.map((item, i) => {
    const prefix = list.ordered ? `${(list.start ?? 1) + i}. ` : "- "
    const content = (item as MdastListItem).children
      .map((c) => mdastToString(c as MdastBlockContent)).join("\n")
    return prefix + content
  }).join("\n")

/**
 * Convert MDAST phrasing content to Markdown string.
 */
const phrasingToString = (c: MdastPhrasingContent): string => {
  switch (c.type) {
    case "text":
      return c.value
    case "inlineCode":
      return `\`${c.value}\``
    case "strong":
      return `**${c.children.map(phrasingToString).join("")}**`
    case "emphasis":
      return `_${c.children.map(phrasingToString).join("")}_`
    case "link":
      return `[${c.children.map(phrasingToString).join("")}](${c.url})`
    case "delete":
      return `~~${c.children.map(phrasingToString).join("")}~~`
    case "break":
      return "  \n"
    case "image":
      return c.alt ?? ""
    case "html":
      return c.value
    default:
      return exhaustive(c)
  }
}

/**
 * Convert MDAST block content to Markdown string.
 *
 * @category Utilities
 */
export const mdastToString = (node: MdastBlockContent): string => {
  switch (node.type) {
    case "paragraph":
      return node.children.map(phrasingToString).join("")
    case "heading":
      return "#".repeat(node.depth) + " " + node.children.map(phrasingToString).join("")
    case "code":
      return "```" + (node.lang ?? "") + "\n" + node.value + "\n```"
    case "thematicBreak":
      return "---"
    case "html":
      return node.value
    case "blockquote":
      return node.children.map((c) => "> " + mdastToString(c as MdastBlockContent)).join("\n")
    case "list":
      return listToString(node)
    case "table":
      return tableToString(node)
    default:
      return exhaustive(node)
  }
}
