/**
 * A `git diff` parsed into files, hunks and numbered lines.
 *
 * Only what the renderer and the anchoring need: which files changed and how, and for
 * every line in a hunk its number on the old and the new side. Anything git adds that we do
 * not render (index lines, modes, similarity) is skipped, never rejected.
 */

/** A malformed patch cannot supply trustworthy source line positions. */
export interface PatchInvalid {
  readonly _tag: "PatchInvalid"
  readonly reason: string
}

/** What `parsePatch` returns: either a patch, or the reason it could not be trusted. */
export type ParseResult = { readonly _tag: "Patch"; readonly patch: Patch } | PatchInvalid

const invalid = (reason: string): PatchInvalid => ({ _tag: "PatchInvalid", reason })

type UnquotedPath = { readonly _tag: "Path"; readonly path: string } | PatchInvalid
export type LineKind = "context" | "add" | "del"

export interface DiffLine {
  readonly kind: LineKind
  readonly text: string
  /** Line number in the old file; absent on added lines. */
  readonly oldNo?: number
  /** Line number in the new file; absent on deleted lines. */
  readonly newNo?: number
}

export interface Hunk {
  readonly header: string
  readonly oldStart: number
  readonly newStart: number
  readonly lines: ReadonlyArray<DiffLine>
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed"

export interface FileDiff {
  /** The path a guide refers to: the new path, or the old one when the file was deleted. */
  readonly path: string
  readonly oldPath: string
  readonly newPath: string
  readonly status: FileStatus
  readonly binary: boolean
  readonly hunks: ReadonlyArray<Hunk>
}

export interface Patch {
  readonly files: ReadonlyArray<FileDiff>
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
const HEADER = /^diff --git (a\/.*|"a\/.*") (b\/.*|"b\/.*")$/

const stripPrefix = (path: string): string => (path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path)

const unquote = (path: string): UnquotedPath => {
  if (!path.startsWith("\"")) return { _tag: "Path", path }
  if (!path.endsWith("\"")) return invalid("Unclosed quoted path")
  const source = path.slice(1, -1)
  const bytes: Array<number> = []
  const encoder = new TextEncoder()
  const escapes = new Map([
    ["a", 7],
    ["b", 8],
    ["t", 9],
    ["n", 10],
    ["v", 11],
    ["f", 12],
    ["r", 13],
    ["\"", 34],
    ["\\", 92]
  ])
  let offset = 0
  for (const match of source.matchAll(/\\([0-7]{3}|.)/g)) {
    for (const byte of encoder.encode(source.slice(offset, match.index))) bytes.push(byte)
    const code = match[1] ?? ""
    const byte = /^[0-7]{3}$/.test(code) ? parseInt(code, 8) : escapes.get(code)
    if (byte === undefined || byte > 255) return invalid("Invalid quoted path escape")
    bytes.push(byte)
    offset = match.index + match[0].length
  }
  for (const byte of encoder.encode(source.slice(offset))) bytes.push(byte)
  return { _tag: "Path", path: new TextDecoder().decode(new Uint8Array(bytes)) }
}

/**
 * Parse a git unified diff, preserving source line numbers.
 *
 * Returns `PatchInvalid` rather than throwing, so a malformed patch is a value the caller
 * has to handle instead of an exception it can forget.
 */
export const parsePatch = (text: string): ParseResult => {
  const lines = text.split("\n")
  const files: Array<FileDiff> = []
  let index = 0

  while (index < lines.length) {
    const header = HEADER.exec(lines[index] ?? "")
    if (header === null) {
      index += 1
      continue
    }
    const oldHeader = unquote(header[1] ?? "")
    if (oldHeader._tag === "PatchInvalid") return oldHeader
    const newHeader = unquote(header[2] ?? "")
    if (newHeader._tag === "PatchInvalid") return newHeader
    let oldPath = stripPrefix(oldHeader.path)
    let newPath = stripPrefix(newHeader.path)
    let status: FileStatus = "modified"
    let binary = false
    const hunks: Array<Hunk> = []
    index += 1

    // Extended headers up to the first hunk or the next file.
    while (index < lines.length && !HEADER.test(lines[index] ?? "")) {
      const line = lines[index] ?? ""
      if (line.startsWith("new file mode")) status = "added"
      else if (line.startsWith("deleted file mode")) status = "deleted"
      else if (line.startsWith("rename from ")) {
        status = "renamed"
        const renamed = unquote(line.slice("rename from ".length))
        if (renamed._tag === "PatchInvalid") return renamed
        oldPath = renamed.path
      } else if (line.startsWith("rename to ")) {
        status = "renamed"
        const renamed = unquote(line.slice("rename to ".length))
        if (renamed._tag === "PatchInvalid") return renamed
        newPath = renamed.path
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        binary = true
      } else if (line.startsWith("--- ")) {
        const source = line.slice(4).replace(/\t$/, "")
        if (source !== "/dev/null") {
          const unquoted = unquote(source)
          if (unquoted._tag === "PatchInvalid") return unquoted
          oldPath = stripPrefix(unquoted.path)
        }
      } else if (line.startsWith("+++ ")) {
        const target = line.slice(4).replace(/\t$/, "")
        if (target !== "/dev/null") {
          const unquoted = unquote(target)
          if (unquoted._tag === "PatchInvalid") return unquoted
          newPath = stripPrefix(unquoted.path)
        }
      } else if (HUNK.test(line)) {
        const parsed = readHunk(lines, index)
        if (parsed._tag === "PatchInvalid") return parsed
        hunks.push(parsed.hunk)
        index = parsed.next
        continue
      } else if (line.startsWith("@@") || line.startsWith("+") || line.startsWith("-")) {
        return invalid(`Unexpected patch body at line ${index + 1}`)
      }
      index += 1
    }

    files.push({
      path: status === "deleted" ? oldPath : newPath,
      oldPath,
      newPath,
      status,
      binary,
      hunks
    })
  }

  if (files.length === 0 && text.trim() !== "") return invalid("Expected a git unified diff")
  return { _tag: "Patch", patch: { files } }
}

const readHunk = (
  lines: ReadonlyArray<string>,
  start: number
): { readonly _tag: "Hunk"; readonly hunk: Hunk; readonly next: number } | PatchInvalid => {
  const match = HUNK.exec(lines[start] ?? "")
  if (match === null) return invalid(`not a hunk header at line ${start + 1}`)
  const oldStart = Number(match[1])
  const newStart = Number(match[3])
  let oldCount = match[2] === undefined ? 1 : Number(match[2])
  let newCount = match[4] === undefined ? 1 : Number(match[4])
  let oldNo = oldStart
  let newNo = newStart
  const body: Array<DiffLine> = []
  let index = start + 1

  while (index < lines.length && (oldCount > 0 || newCount > 0)) {
    const line = lines[index] ?? ""
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the line above it.
      index += 1
      continue
    }
    const marker = line[0]
    const text = line.slice(1)
    if (marker === "+") {
      body.push({ kind: "add", text, newNo })
      newNo += 1
      newCount -= 1
    } else if (marker === "-") {
      body.push({ kind: "del", text, oldNo })
      oldNo += 1
      oldCount -= 1
    } else if (marker === " ") {
      body.push({ kind: "context", text, oldNo, newNo })
      oldNo += 1
      newNo += 1
      oldCount -= 1
      newCount -= 1
    } else {
      break
    }
    index += 1
  }
  if (oldCount !== 0 || newCount !== 0) return invalid(`Incomplete hunk at line ${start + 1}`)
  // A trailing "\ No newline at end of file" after the last counted line.
  if ((lines[index] ?? "").startsWith("\\")) index += 1

  return {
    _tag: "Hunk",
    hunk: { header: match[5]?.trim() ?? "", oldStart, newStart, lines: body },
    next: index
  }
}

/** Every path a guide may use for this file: the new one first, the old one for renames. */
export const pathsOf = (file: FileDiff): ReadonlyArray<string> =>
  file.oldPath === file.newPath ? [file.path] : [file.newPath, file.oldPath]

export const findFile = (patch: Patch, path: string): FileDiff | undefined =>
  patch.files.find((file) => file.path === path) ?? patch.files.find((file) => pathsOf(file).includes(path))
