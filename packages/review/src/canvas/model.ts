/**
 * Browser-safe canvas contracts. A host reads the reviewed head into a `CanvasReading`; the canvas only draws it.
 * Every source the canvas can show has an explicit `NotRecorded` state, never an empty success.
 * Paths are repository-relative change paths; provider locators and credentials never enter this boundary.
 * @module
 */
import { Schema } from "effect"

const Name = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256))
const Text = Schema.String.check(Schema.isMaxLength(4_096))
const Path = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\\]+$/u)
)
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 }))
const LineNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000_000 }))
// Reading times must fit the Date/Intl formatting boundary used by the views.
const Timestamp = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })
)
const NotRecorded = Schema.TaggedStruct("NotRecorded", {})

/** How one changed part relates to the base. Moves name the other file; they come from a call-level reader. */
export const CanvasPartKind = Schema.Literals(["added", "modified", "removed", "moved_to", "moved_from"])
export type CanvasPartKind = typeof CanvasPartKind.Type

/** One changed declaration of a file: a function, a class member, or the file's imports and types. */
export const CanvasPart = Schema.Struct({
  name: Name,
  kind: CanvasPartKind,
  movedPath: Schema.NullOr(Path),
  /** Head-side lines; null when the part is gone from the head. */
  lines: Schema.NullOr(Schema.Struct({ start: LineNumber, end: LineNumber })),
  added: Count,
  removed: Count
}).check(Schema.makeFilter(
  (part) =>
    (part.kind === "moved_to" || part.kind === "moved_from") === (part.movedPath !== null) &&
    (part.lines === null || part.lines.start <= part.lines.end) &&
    (part.kind === "removed" || part.kind === "moved_to") === (part.lines === null),
  { expected: "a move names its other file, and only parts still in the head have lines in order" }
))
export type CanvasPart = typeof CanvasPart.Type

export const CanvasParts = Schema.Union([
  NotRecorded,
  Schema.TaggedStruct("Recorded", { items: Schema.Array(CanvasPart).check(Schema.isMaxLength(200)) })
])
export type CanvasParts = typeof CanvasParts.Type

export const CanvasFile = Schema.Struct({
  path: Path,
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  previousPath: Schema.NullOr(Path),
  added: Count,
  removed: Count,
  parts: CanvasParts
})
export type CanvasFile = typeof CanvasFile.Type

/** `imports` is file-level. `calls` and `moved_from` come from a call-level reader and name their parts. */
export const CanvasRelation = Schema.Literals(["imports", "calls", "moved_from"])
export type CanvasRelation = typeof CanvasRelation.Type

/** Directed from the dependent to its dependency: the importer or caller to the callee. */
export const CanvasEdge = Schema.Struct({
  from: Path,
  to: Path,
  relation: CanvasRelation,
  fromPart: Schema.NullOr(Name),
  toPart: Schema.NullOr(Name)
})
export type CanvasEdge = typeof CanvasEdge.Type

/** No reader for this change's language is a known absence, shown as "no dependency data", never as no edges. */
export const CanvasDependencies = Schema.Union([
  Schema.TaggedStruct("Recorded", { edges: Schema.Array(CanvasEdge).check(Schema.isMaxLength(5_000)) }),
  Schema.TaggedStruct("NotRecorded", { language: Schema.NullOr(Name) })
])
export type CanvasDependencies = typeof CanvasDependencies.Type

/** Edits that share a def-use chain. Ids are short reading labels such as "A". */
export const CanvasPartition = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,3}$/u)),
  title: Name,
  why: Text,
  files: Schema.Array(Path).check(Schema.isMinLength(1), Schema.isMaxLength(1_000), Schema.isUnique())
})
export type CanvasPartition = typeof CanvasPartition.Type

export const CanvasPartitions = Schema.Union([
  NotRecorded,
  Schema.TaggedStruct("Recorded", { items: Schema.Array(CanvasPartition).check(Schema.isMaxLength(26)) })
])
export type CanvasPartitions = typeof CanvasPartitions.Type

const partsOf = (file: CanvasFile): ReadonlyArray<CanvasPart> => file.parts._tag === "Recorded" ? file.parts.items : []

/** The reviewed head's change graph. Edges and partitions only name files in this change. */
export const CanvasGraph = Schema.Struct({
  headRevision: Name,
  files: Schema.Array(CanvasFile).check(Schema.isMaxLength(1_000)),
  dependencies: CanvasDependencies,
  partitions: CanvasPartitions
}).check(Schema.makeFilter((graph) => {
  const paths = new Set(graph.files.map((file) => file.path))
  if (paths.size !== graph.files.length) return false
  if (graph.files.some((file) => new Set(partsOf(file).map((part) => part.name)).size !== partsOf(file).length)) {
    return false
  }
  if (
    graph.dependencies._tag === "Recorded" &&
    graph.dependencies.edges.some((edge) => !paths.has(edge.from) || !paths.has(edge.to) || edge.from === edge.to)
  ) return false
  if (graph.partitions._tag === "Recorded") {
    const ids = graph.partitions.items.map((partition) => partition.id)
    const members = graph.partitions.items.flatMap((partition) => partition.files)
    if (new Set(ids).size !== ids.length || new Set(members).size !== members.length) return false
    if (members.some((path) => !paths.has(path))) return false
  }
  return true
}, { expected: "unique files, parts and partitions; edges and partitions name files in this change" }))
export type CanvasGraph = typeof CanvasGraph.Type

/**
 * Reading the head takes a while. Building lists the files read so far and how many of the change's files are
 * placed; the file list works meanwhile, the map does not.
 */
export const CanvasGraphReading = Schema.Union([
  Schema.TaggedStruct("Building", {
    headRevision: Name,
    placed: Count,
    total: Count,
    files: Schema.Array(CanvasFile).check(Schema.isMaxLength(1_000))
  }).check(
    Schema.makeFilter(
      (building) =>
        building.placed <= building.files.length && building.files.length <= building.total &&
        new Set(building.files.map((file) => file.path)).size === building.files.length,
      { expected: "unique files read so far, placed within them, within the change's total" }
    )
  ),
  Schema.TaggedStruct("Ready", { graph: CanvasGraph })
])
export type CanvasGraphReading = typeof CanvasGraphReading.Type

/** The viewer's previous look at this PR: when, at which head, and what changed since. */
export const CanvasLastLook = Schema.Union([
  NotRecorded,
  Schema.TaggedStruct("Recorded", {
    at: Timestamp,
    head: Name,
    commitsSince: Count,
    changedFiles: Schema.Array(Path).check(Schema.isMaxLength(1_000), Schema.isUnique())
  })
])
export type CanvasLastLook = typeof CanvasLastLook.Type

/** A partition chapter names its partition; a chapter without one, such as tests, has none. */
export const CanvasChapter = Schema.Struct({
  partition: Schema.NullOr(CanvasPartition.fields.id),
  title: Name,
  why: Text,
  files: Schema.Array(Path).check(Schema.isMinLength(1), Schema.isMaxLength(1_000), Schema.isUnique())
})
export type CanvasChapter = typeof CanvasChapter.Type

export const CanvasReadingPath = Schema.Union([
  NotRecorded,
  Schema.TaggedStruct("Recorded", {
    chapters: Schema.Array(CanvasChapter).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    read: Schema.Array(Path).check(Schema.isMaxLength(1_000), Schema.isUnique()),
    current: Schema.NullOr(Path)
  })
])
export type CanvasReadingPath = typeof CanvasReadingPath.Type

/** A failing test case from a check run on the reviewed head. */
export const CanvasTestFailure = Schema.Struct({ check: Name, file: Path, test: Text })
export type CanvasTestFailure = typeof CanvasTestFailure.Type

/** Life of a finding across heads. Keys are review thread ids. */
export const CanvasFindingNote = Schema.Struct({
  life: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("StillOpen", { raisedAt: Timestamp, raisedHead: Name }),
    Schema.TaggedStruct("Fixed", { head: Name })
  ]),
  evidence: Schema.NullOr(CanvasTestFailure)
})
export type CanvasFindingNote = typeof CanvasFindingNote.Type

export const CanvasFindingNotes = Schema.Union([
  NotRecorded,
  Schema.TaggedStruct("Recorded", {
    notes: Schema.Record(Name, CanvasFindingNote).check(
      Schema.makeFilter((notes) => Object.keys(notes).length <= 500, { expected: "at most 500 finding notes" })
    )
  })
])
export type CanvasFindingNotes = typeof CanvasFindingNotes.Type

export const CanvasTests = Schema.Union([
  NotRecorded,
  Schema.TaggedStruct("Recorded", { failing: Schema.Array(CanvasTestFailure).check(Schema.isMaxLength(500)) })
])
export type CanvasTests = typeof CanvasTests.Type

/** Review state around the graph. Each source arrives with its own reader; until then it is NotRecorded. */
export const CanvasReviewContext = Schema.Struct({
  lastLook: CanvasLastLook,
  readingPath: CanvasReadingPath,
  findings: CanvasFindingNotes,
  tests: CanvasTests
})
export type CanvasReviewContext = typeof CanvasReviewContext.Type

export const CanvasReading = Schema.Struct({
  graph: CanvasGraphReading,
  context: CanvasReviewContext
}).check(Schema.makeFilter((reading) => {
  if (reading.graph._tag !== "Ready" || reading.context.readingPath._tag !== "Recorded") return true
  const paths = new Set(reading.graph.graph.files.map((file) => file.path))
  const path = reading.context.readingPath
  const listed = path.chapters.flatMap((chapter) => chapter.files)
  return new Set(listed).size === listed.length && listed.every((file) => paths.has(file)) &&
    path.read.every((file) => paths.has(file)) && (path.current === null || paths.has(path.current))
}, { expected: "a reading path lists each file of this change at most once" }))
export type CanvasReading = typeof CanvasReading.Type

const containers = new Set(["packages", "apps", "libs", "services", "crates", "modules"])

/**
 * The module a file belongs to: its first directory, or `container/name` under a workspace container such as
 * `packages/`. Files at the repository root form the "." module.
 */
export const canvasModuleOf = (path: string): string => {
  const segments = path.split("/")
  if (segments.length === 1) return "."
  const first = segments[0] ?? "."
  return containers.has(first) && segments.length > 2 ? `${first}/${segments[1]}` : first
}
