/**
 * Plain text and links from the rows of a rendered terminal screen.
 *
 * Connect receives herdr's re-rendered screens, which carry no soft-wrap flags. A row that fills
 * the full width is therefore treated as wrapping into the next one — a heuristic, chosen because
 * URLs and long commands usually wrap and copying them whole matters more than the rare row that
 * ends exactly at the margin. A wrap that lands on a space leaves a blank last cell, which looks
 * the same as a short line, so that one stays split.
 *
 * @module
 */

/**
 * One screen row as cells: entry `i` is column `i`'s text — `" "` for an empty cell and `""` for
 * the second half of a wide character — so joining the cells gives the row's text and an index is
 * always a terminal column, whatever wide characters or cursor-made gaps the row holds.
 */
export type ScreenRow = ReadonlyArray<string>

/** A run of screen rows read as one line; `rowStarts[i]` is the text offset of row `firstRow + i`. */
export interface LogicalLine {
  readonly firstRow: number
  readonly rowStarts: ReadonlyArray<number>
  readonly text: string
}

/** A link found in a logical line, as text offsets `[start, end)`. */
export interface TerminalUrl {
  readonly end: number
  readonly start: number
  readonly url: string
}

/** A cell on the screen, `row` counted from the top of the visible screen. */
export interface ScreenCell {
  readonly col: number
  readonly row: number
}

/** A row of plain single-width text, padded to `cols` — how tests and simple callers build rows. */
export const textRow = (text: string, cols: number): ScreenRow => {
  const cells = Array.from(text)
  return [...cells, ...Array.from({ length: Math.max(0, cols - cells.length) }, () => " ")]
}

const textOf = (cells: ReadonlyArray<string>): string => cells.join("")

/** Text offset of a column; the second half of a wide character belongs to the character itself. */
const textOffset = (row: ScreenRow, col: number): number => {
  let owner = col
  while (owner > 0 && row[owner] === "") owner -= 1
  return textOf(row.slice(0, owner)).length
}

// The second half of a wide character in the last column also fills the row.
const fillsRow = (row: ScreenRow, cols: number): boolean => row.length >= cols && row[cols - 1] !== " "

/** Group full-width rows with the row they wrap into. */
export const logicalLines = (rows: ReadonlyArray<ScreenRow>, cols: number): ReadonlyArray<LogicalLine> => {
  const lines: Array<LogicalLine> = []
  let firstRow = 0
  let text = ""
  let rowStarts: Array<number> = []
  rows.forEach((row, index) => {
    if (rowStarts.length === 0) firstRow = index
    rowStarts.push(text.length)
    const wraps = fillsRow(row, cols) && index < rows.length - 1
    text += wraps ? textOf(row.slice(0, cols)) : textOf(row).trimEnd()
    if (!wraps) {
      lines.push({ firstRow, rowStarts, text })
      text = ""
      rowStarts = []
    }
  })
  if (rowStarts.length > 0) lines.push({ firstRow, rowStarts, text })
  return lines
}

/** Copy text for a selection from `start` to `end` inclusive: trailing spaces trimmed, wraps joined. */
export const selectionText = (
  rows: ReadonlyArray<ScreenRow>,
  cols: number,
  start: ScreenCell,
  end: ScreenCell
): string => {
  const [from, to] = start.row < end.row || (start.row === end.row && start.col <= end.col)
    ? [start, end]
    : [end, start]
  const selected = rows.slice(from.row, to.row + 1).map((row, index, all) => {
    const left = index === 0 ? from.col : 0
    const right = index === all.length - 1 ? to.col + 1 : cols
    return textOf(row.slice(left, right))
  })
  // Wrap decisions use the whole row, not the selected slice, so a partial first row still joins.
  const pieces: Array<string> = []
  selected.forEach((piece, index) => {
    const row = rows[from.row + index] ?? []
    const wraps = index < selected.length - 1 && fillsRow(row, cols)
    pieces.push(wraps ? piece : `${piece.trimEnd()}\n`)
  })
  return pieces.join("").replace(/\n$/, "")
}

const urlCandidate = /https?:\/\/[^\s<>"'`]+/gi
const trailingPunctuation = /[.,;:!?'"]+$/
const closers = new Map([[")", "("], ["]", "["], ["}", "{"]])

const occurrences = (text: string, character: string): number => text.split(character).length - 1

/** Drop sentence punctuation and closing brackets the URL never opened. */
const trimUrl = (raw: string): string => {
  let url = raw.replace(trailingPunctuation, "")
  for (;;) {
    const last = url.at(-1)
    const opener = last === undefined ? undefined : closers.get(last)
    if (last === undefined || opener === undefined) return url
    if (occurrences(url, opener) >= occurrences(url, last)) return url
    url = url.slice(0, -1).replace(trailingPunctuation, "")
  }
}

/** The URL to open, or null. Only http and https are ever opened. */
export const safeUrl = (raw: string): string | null => {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null
  } catch {
    return null
  }
}

/** Every http(s) URL in one logical line. */
export const findUrls = (text: string): ReadonlyArray<TerminalUrl> => {
  const found: Array<TerminalUrl> = []
  for (const match of text.matchAll(urlCandidate)) {
    const trimmed = trimUrl(match[0])
    const url = safeUrl(trimmed)
    if (url !== null) found.push({ start: match.index, end: match.index + trimmed.length, url })
  }
  return found
}

/** The URL under a screen cell, following wrapped rows. */
export const urlAt = (rows: ReadonlyArray<ScreenRow>, cols: number, cell: ScreenCell): TerminalUrl | null => {
  const line = logicalLines(rows, cols).find((candidate) =>
    cell.row >= candidate.firstRow && cell.row < candidate.firstRow + candidate.rowStarts.length
  )
  if (line === undefined) return null
  const offset = (line.rowStarts[cell.row - line.firstRow] ?? 0) + textOffset(rows[cell.row] ?? [], cell.col)
  return findUrls(line.text).find((url) => offset >= url.start && offset < url.end) ?? null
}
