/**
 * Build the canvas graph of one immutable PR revision from its changed files' base and head text.
 * TypeScript and JavaScript files get file-level import edges, resolved only between files of this change, and
 * their changed top-level declarations. Other languages are recorded as having no dependency data; nothing is
 * guessed. Call-level edges, moves and partitions come from a later reader and stay NotRecorded here.
 * @module
 */
import {
  CANVAS_MODULE_PART,
  type CanvasEdge,
  type CanvasFile,
  type CanvasGraph,
  type CanvasPart
} from "@knpkv/review/canvas"
import { diffLines } from "diff"
import { scanScript } from "./ScriptScanner.js"

export interface CanvasSourceFile {
  readonly path: string
  readonly status: CanvasFile["status"]
  readonly previousPath: string | null
  /** Text of both sides; binary and oversized files are opaque. */
  readonly content:
    | { readonly _tag: "Text"; readonly before: string | null; readonly after: string | null }
    | { readonly _tag: "Opaque" }
}

const scriptExtensions = new Set(["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"])

const languages = new Map<string, string>([
  ["go", "Go"],
  ["py", "Python"],
  ["rs", "Rust"],
  ["java", "Java"],
  ["kt", "Kotlin"],
  ["rb", "Ruby"],
  ["cs", "C#"],
  ["swift", "Swift"],
  ["php", "PHP"],
  ["scala", "Scala"],
  ["c", "C"],
  ["h", "C"],
  ["cpp", "C++"],
  ["hpp", "C++"]
])

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase()
}

const isScript = (path: string): boolean => scriptExtensions.has(extensionOf(path))

interface Declaration {
  readonly name: string
  readonly start: number
  readonly end: number
}

/** Top-level functions, function-valued constants and classes, with 1-based line ranges. */
const declarationsOf = (text: string): ReadonlyArray<Declaration> => scanScript(text).declarations

interface LineChanges {
  readonly added: ReadonlySet<number>
  readonly removed: ReadonlySet<number>
  /** Changed lines with visible text; blank lines count in totals but place no part. */
  readonly visibleAdded: ReadonlySet<number>
  readonly visibleRemoved: ReadonlySet<number>
}

const lineChanges = (before: string, after: string): LineChanges => {
  const added = new Set<number>()
  const removed = new Set<number>()
  const visibleAdded = new Set<number>()
  const visibleRemoved = new Set<number>()
  let beforeLine = 1
  let afterLine = 1
  for (const change of diffLines(before, after)) {
    const lines = change.value.split("\n")
    if (lines.at(-1) === "") lines.pop()
    for (const text of lines) {
      if (change.added === true) {
        added.add(afterLine)
        if (text.trim() !== "") visibleAdded.add(afterLine)
        afterLine += 1
      } else if (change.removed === true) {
        removed.add(beforeLine)
        if (text.trim() !== "") visibleRemoved.add(beforeLine)
        beforeLine += 1
      } else {
        beforeLine += 1
        afterLine += 1
      }
    }
  }
  return { added, removed, visibleAdded, visibleRemoved }
}

const within = (lines: ReadonlySet<number>, declaration: Declaration): number => {
  let count = 0
  for (const line of lines) if (line >= declaration.start && line <= declaration.end) count += 1
  return count
}

const outside = (lines: ReadonlySet<number>, declarations: ReadonlyArray<Declaration>): ReadonlyArray<number> =>
  Array.from(lines).filter((line) => declarations.every((entry) => line < entry.start || line > entry.end)).sort(
    (left, right) => left - right
  )

/** Changed declarations in head order, then the module part, then declarations gone from the head. */
const partsOf = (
  status: CanvasFile["status"],
  before: string,
  after: string,
  changes: LineChanges
): ReadonlyArray<CanvasPart> => {
  const head = declarationsOf(after)
  const base = declarationsOf(before)
  const baseByName = new Map(base.map((entry) => [entry.name, entry]))
  const headNames = new Set(head.map((entry) => entry.name))
  const parts: Array<CanvasPart> = []
  for (const declaration of head) {
    const previous = baseByName.get(declaration.name)
    const added = within(changes.added, declaration)
    const removed = previous === undefined ? 0 : within(changes.removed, previous)
    if (added === 0 && removed === 0) continue
    parts.push({
      name: declaration.name,
      kind: previous === undefined || status === "added" ? "added" : "modified",
      movedPath: null,
      lines: { start: declaration.start, end: declaration.end },
      added,
      removed
    })
  }
  const headOutside = outside(changes.visibleAdded, head)
  const baseOutside = outside(changes.visibleRemoved, base)
  const first = headOutside[0]
  const last = headOutside.at(-1)
  if (first !== undefined && last !== undefined) {
    parts.push({
      name: CANVAS_MODULE_PART,
      kind: status === "added" ? "added" : "modified",
      movedPath: null,
      lines: { start: first, end: last },
      added: headOutside.length,
      removed: baseOutside.length
    })
  } else if (baseOutside.length > 0) {
    parts.push({
      name: CANVAS_MODULE_PART,
      kind: "removed",
      movedPath: null,
      lines: null,
      added: 0,
      removed: baseOutside.length
    })
  }
  for (const declaration of base) {
    if (headNames.has(declaration.name)) continue
    const removed = within(changes.removed, declaration)
    if (removed === 0) continue
    parts.push({ name: declaration.name, kind: "removed", movedPath: null, lines: null, added: 0, removed })
  }
  return parts
}

/** One file's counts and changed parts, before any edges are known. */
export const canvasFileOf = (source: CanvasSourceFile): CanvasFile => {
  const base = { path: source.path, status: source.status, previousPath: source.previousPath }
  if (source.content._tag === "Opaque") return { ...base, added: 0, removed: 0, parts: { _tag: "NotRecorded" } }
  const before = source.content.before ?? ""
  const after = source.content.after ?? ""
  const changes = lineChanges(before, after)
  return {
    ...base,
    added: changes.added.size,
    removed: changes.removed.size,
    parts: !isScript(source.path)
      ? { _tag: "NotRecorded" }
      : { _tag: "Recorded", items: partsOf(source.status, before, after, changes) }
  }
}

/** Normalize a slash path; null when it climbs above the repository root. */
const normalize = (path: string): string | null => {
  const segments: Array<string> = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return null
      segments.pop()
    } else segments.push(segment)
  }
  return segments.join("/")
}

const sourceExtensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]
const emittedToSource = new Map<string, ReadonlyArray<string>>([
  ["js", ["ts", "tsx", "js", "jsx"]],
  ["jsx", ["tsx", "jsx"]],
  ["mjs", ["mts", "mjs"]],
  ["cjs", ["cts", "cjs"]]
])

/** Resolve a relative specifier to a file of this change, the way TypeScript's bundler resolution would. */
const resolveSpecifier = (from: string, specifier: string, known: ReadonlySet<string>): string | null => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null
  const directory = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : ""
  const target = normalize(`${directory}/${specifier}`)
  if (target === null || target === "") return null
  const extension = extensionOf(target)
  const stem = extension === "" ? target : target.slice(0, -(extension.length + 1))
  const candidates = [
    target,
    ...(emittedToSource.get(extension) ?? []).map((source) => `${stem}.${source}`),
    ...sourceExtensions.map((source) => `${target}.${source}`),
    ...sourceExtensions.map((source) => `${target}/index.${source}`)
  ]
  return candidates.find((candidate) => known.has(candidate)) ?? null
}

/** The language most of the change is written in, for "no dependency data for …". */
const languageOf = (sources: ReadonlyArray<CanvasSourceFile>): string | null => {
  const counts = new Map<string, number>()
  for (const source of sources) {
    const language = languages.get(extensionOf(source.path))
    if (language !== undefined) counts.set(language, (counts.get(language) ?? 0) + 1)
  }
  return Array.from(counts).sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))[0]?.[0] ?? null
}

export const buildCanvasGraph = (headRevision: string, sources: ReadonlyArray<CanvasSourceFile>): CanvasGraph => {
  const files = sources.map(canvasFileOf)
  const scripts = sources.filter((source) => isScript(source.path))
  if (scripts.length === 0) {
    return {
      headRevision,
      files,
      dependencies: { _tag: "NotRecorded", language: languageOf(sources) },
      partitions: { _tag: "NotRecorded" }
    }
  }
  const known = new Set(sources.filter((source) => source.status !== "deleted").map((source) => source.path))
  const seen = new Set<string>()
  const edges = scripts.flatMap((source): ReadonlyArray<CanvasEdge> => {
    if (source.content._tag !== "Text" || source.content.after === null) return []
    return scanScript(source.content.after).specifiers.flatMap((specifier) => {
      const to = resolveSpecifier(source.path, specifier, known)
      const key = JSON.stringify([source.path, to])
      if (to === null || to === source.path || seen.has(key)) return []
      seen.add(key)
      return [{ from: source.path, to, relation: "imports", fromPart: null, toPart: null }]
    })
  })
  return { headRevision, files, dependencies: { _tag: "Recorded", edges }, partitions: { _tag: "NotRecorded" } }
}
