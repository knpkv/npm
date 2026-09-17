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

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied"

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
const HEADER = "diff --git "

/** Custom Git prefixes cannot be inferred reliably from filenames; supply the exact producer options. */
export interface PatchPrefixes {
  readonly source: string
  readonly destination: string
}

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
  try {
    return {
      _tag: "Path",
      path: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes))
    }
  } catch {
    return invalid("Quoted Git path is not valid UTF-8")
  }
}

/** Resolve header boundaries against file markers; spaces in unquoted filenames are legal Git output. */
const headerPaths = (
  header: string,
  source: string | undefined,
  destination: string | undefined,
  prefixes: PatchPrefixes | undefined,
  moved: { readonly source: string; readonly destination: string } | undefined
): { readonly _tag: "Paths"; readonly oldPath: string; readonly newPath: string } | PatchInvalid => {
  const candidates: Array<{ readonly oldPath: string; readonly newPath: string }> = []
  for (let index = 0; index < header.length; index++) {
    if (header[index] !== " ") continue
    const left = unquote(header.slice(0, index))
    const right = unquote(header.slice(index + 1))
    if (left._tag === "PatchInvalid" || right._tag === "PatchInvalid") continue
    if (left.path === "" || right.path === "") continue
    if (source !== undefined && source !== "/dev/null" && source !== left.path) continue
    if (destination !== undefined && destination !== "/dev/null" && destination !== right.path) continue
    const selected = prefixes ?? (left.path.startsWith("a/") && right.path.startsWith("b/")
      ? { source: "a/", destination: "b/" }
      : { source: "", destination: "" })
    if (!left.path.startsWith(selected.source) || !right.path.startsWith(selected.destination)) continue
    const oldPath = left.path.slice(selected.source.length)
    const newPath = right.path.slice(selected.destination.length)
    if (oldPath === "" || newPath === "") continue
    if (moved !== undefined && (oldPath !== moved.source || newPath !== moved.destination)) continue
    if (moved === undefined && source === undefined && destination === undefined && oldPath !== newPath) continue
    candidates.push({ oldPath, newPath })
  }
  const paths = candidates[0]
  return candidates.length === 1 && paths !== undefined
    ? { _tag: "Paths", ...paths }
    : invalid("Inconsistent or ambiguous Git file headers; custom prefixes must be supplied explicitly")
}

/** Parse Git unified diffs with default or no prefixes; custom producer prefixes must be explicit. */
export const parsePatch = (text: string, prefixes?: PatchPrefixes): ParseResult => {
  // A CR on a Git header identifies transport line endings; body-only CR belongs to the source.
  const records = text.split("\n")
  const converted = records.some((line) => line.startsWith(HEADER) && line.endsWith("\r"))
  const lines = converted ? records.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line) : records
  const files: Array<FileDiff> = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (!line.startsWith(HEADER)) {
      index += 1
      continue
    }
    const header = line.slice(HEADER.length)
    let source: string | undefined
    let destination: string | undefined
    let movedSource: string | undefined
    let movedDestination: string | undefined
    let status: FileStatus = "modified"
    let binary = false
    const hunks: Array<Hunk> = []
    const oldCoordinates = new Set<number>()
    const newCoordinates = new Set<number>()
    index += 1

    while (index < lines.length && !(lines[index] ?? "").startsWith(HEADER)) {
      const line = lines[index] ?? ""
      if (line.startsWith("new file mode")) status = "added"
      else if (line.startsWith("deleted file mode")) status = "deleted"
      else if (/^(rename|copy) (from|to) /.test(line)) {
        const kind = line.startsWith("copy ") ? "copied" : "renamed"
        if (status !== "modified" && status !== kind) return invalid("Conflicting file status headers")
        status = kind
        const path = unquote(line.replace(/^(rename|copy) (from|to) /, ""))
        if (path._tag === "PatchInvalid") return path
        if (/^(rename|copy) from /.test(line)) movedSource = path.path
        else movedDestination = path.path
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) binary = true
      else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        const path = unquote(line.slice(4).replace(/\t$/, ""))
        if (path._tag === "PatchInvalid") return path
        if (line.startsWith("--- ")) source = path.path
        else destination = path.path
      } else if (HUNK.test(line)) {
        const parsed = readHunk(lines, index)
        if (parsed._tag === "PatchInvalid") return parsed
        for (const record of parsed.hunk.lines) {
          if (
            (record.oldNo !== undefined && oldCoordinates.has(record.oldNo)) ||
            (record.newNo !== undefined && newCoordinates.has(record.newNo))
          ) return invalid(`Overlapping hunk at line ${index + 1}`)
          if (record.oldNo !== undefined) oldCoordinates.add(record.oldNo)
          if (record.newNo !== undefined) newCoordinates.add(record.newNo)
        }
        hunks.push(parsed.hunk)
        index = parsed.next
        continue
      } else if (/^(?:@@|[+\- \\])/.test(line)) {
        return invalid(`Unexpected patch body at line ${index + 1}`)
      }
      index += 1
    }
    if ((source === undefined) !== (destination === undefined)) return invalid("Unpaired file markers")
    if ((movedSource === undefined) !== (movedDestination === undefined)) {
      return invalid("Unpaired rename or copy headers")
    }
    const moved = movedSource === undefined || movedDestination === undefined
      ? undefined
      : { source: movedSource, destination: movedDestination }
    const paths = headerPaths(header, source, destination, prefixes, moved)
    if (paths._tag === "PatchInvalid") return paths
    if (source === "/dev/null") status = "added"
    if (destination === "/dev/null") status = "deleted"
    files.push({
      path: status === "deleted" ? paths.oldPath : paths.newPath,
      oldPath: paths.oldPath,
      newPath: paths.newPath,
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
    // A marker belongs to exactly one preceding body record and consumes no coordinate.
    if ((lines[index] ?? "").startsWith("\\")) {
      if (lines[index] !== "\\ No newline at end of file") return invalid(`Invalid newline marker at line ${index + 1}`)
      index += 1
    }
  }
  if (oldCount !== 0 || newCount !== 0) return invalid(`Incomplete hunk at line ${start + 1}`)

  return {
    _tag: "Hunk",
    hunk: { header: match[5]?.trim() ?? "", oldStart, newStart, lines: body },
    next: index
  }
}

/** Every path a guide may use for this file: the new one first, the old one for renames. */
export const pathsOf = (file: FileDiff): ReadonlyArray<string> =>
  file.status === "renamed" ? [file.newPath, file.oldPath] : [file.path]

export const findFile = (patch: Patch, path: string): FileDiff | undefined =>
  patch.files.find((file) => file.path === path) ?? patch.files.find((file) => pathsOf(file).includes(path))
