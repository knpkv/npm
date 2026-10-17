/**
 * The review canvas reference fixture as the Hub's own reads. The design draws one synthetic PR; this module
 * turns it into the detail, review, diff and canvas readings the live Code module requests. Where the design's
 * example disagrees with itself (a cluster edge with no overview edge), the overview's edges win.
 * @module
 */
import {
  CodeCanvasResult,
  CodeDetail,
  CodeDiffContentResult,
  CodeDiffResult,
  CodeQueue,
  CodeReviewResult
} from "@knpkv/codecommit-web/host"
import { Schema } from "effect"
import type { Fixture } from "../../../design-conformance/src/schema.js"
import { DesignCommits, designCommits, makeShellReadings, untokenCommits } from "./fixtures.js"

export const CANVAS_REFERENCE = "00000000-0000-4000-8000-000000000463"

export const CanvasState = Schema.Literals([
  "overview",
  "cluster",
  "file",
  "diff",
  "keyboard",
  "map-building",
  "no-dependency-data"
])
export type CanvasState = typeof CanvasState.Type

const ClockTime = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/u))
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7}$/u))
const Fn = Schema.Struct({
  n: Schema.NonEmptyString,
  kind: Schema.NonEmptyString,
  lines: Schema.Int,
  f: Schema.optionalKey(Schema.String)
})

/** A stub at the canvas edge: which file it stands for and the phrase that says how it meets the drawn file. */
const Stub = Schema.Struct({ label: Schema.NonEmptyString, line: Schema.String })

const CanvasData = Schema.Struct({
  reviewDirections: Schema.Struct({
    canvas: Schema.Struct({
      pr: Schema.Struct({
        repo: Schema.NonEmptyString,
        number: Schema.String.check(Schema.isPattern(/^#\d+$/u)),
        title: Schema.NonEmptyString,
        branch: Schema.NonEmptyString,
        base: Schema.NonEmptyString,
        review: Schema.String.check(Schema.isPattern(/^\S+ review, \d{2}:\d{2}$/u)),
        check: Schema.Struct({ name: Schema.NonEmptyString, result: Schema.String, file: Schema.NonEmptyString }),
        lastLook: ClockTime,
        head: Sha,
        commitsSince: Schema.Array(Schema.Struct({ sha: Sha, at: ClockTime }))
      }),
      partitions: Schema.Array(
        Schema.Struct({ id: Schema.NonEmptyString, title: Schema.NonEmptyString, why: Schema.String })
      ),
      files: Schema.Array(Schema.Struct({
        path: Schema.NonEmptyString,
        partition: Schema.NullOr(Schema.NonEmptyString),
        add: Schema.Int,
        rem: Schema.Int,
        changed: Schema.optionalKey(Schema.Boolean)
      })),
      edges: Schema.Array(Schema.Struct({
        from: Schema.NonEmptyString,
        to: Schema.NonEmptyString,
        rel: Schema.Literals(["calls", "imports", "moved from"])
      })),
      findings: Schema.Record(
        Schema.String,
        Schema.Struct({
          id: Schema.NonEmptyString,
          p: Schema.Literals(["P0", "P1", "P2", "P3", "P4"]),
          file: Schema.NonEmptyString,
          fn: Schema.NonEmptyString,
          life: Schema.String,
          title: Schema.NonEmptyString,
          body: Schema.optionalKey(Schema.String),
          raised: Schema.optionalKey(Schema.String)
        })
      ),
      clusterA: Schema.Struct({
        boxes: Schema.Array(Schema.Struct({
          file: Schema.NonEmptyString,
          x: Schema.Number,
          y: Schema.Number,
          w: Schema.Number,
          fns: Schema.Array(Fn)
        })),
        lines: Schema.Array(Schema.Struct({
          p: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
          rel: Schema.NullOr(Schema.String)
        })),
        stubs: Schema.Array(Stub)
      }),
      fileZoom: Schema.Struct({
        file: Schema.NonEmptyString,
        fns: Schema.Array(Schema.Struct({
          n: Schema.NonEmptyString,
          kind: Schema.NonEmptyString,
          lines: Schema.Int,
          range: Schema.String.check(Schema.isPattern(/^\d+–\d+$/u))
        })),
        stubs: Schema.Array(Stub)
      }),
      diff: Schema.Struct({
        file: Schema.NonEmptyString,
        fn: Schema.NonEmptyString,
        readLine: Schema.String,
        lines: Schema.Array(Schema.Struct({ n: Schema.Int, c: Schema.String })),
        stubs: Schema.Array(Stub)
      }),
      building: Schema.Struct({ line: Schema.String }),
      readingPath: Schema.Struct({
        chapters: Schema.Array(
          Schema.Struct({ id: Schema.NonEmptyString, title: Schema.NonEmptyString, why: Schema.String })
        ),
        order: Schema.Array(Schema.NonEmptyString),
        read: Schema.Array(Schema.NonEmptyString),
        current: Schema.NonEmptyString
      }),
      screen: Schema.Struct({
        shell: Schema.Struct({
          hosts: Schema.Struct({ label: Schema.String }),
          session: Schema.Struct({ title: Schema.String })
        }),
        approvals: Schema.Struct({ badge: Schema.NumberFromString })
      })
    })
  })
})

const day = "2026-10-16"
const at = (time: string): number => Date.parse(`${day}T${time}:00.000Z`)
const full = (sha: string): string => sha.padEnd(40, "0")

const decode = (data: Fixture["data"]) =>
  Schema.decodeUnknownSync(CanvasData)(untokenCommits(data)).reviewDirections.canvas

const CanvasCommits = Schema.Struct({
  reviewDirections: Schema.Struct({ canvas: Schema.Struct({ commits: Schema.optionalKey(DesignCommits) }) })
})

const canvasCommits = (data: Fixture["data"]) =>
  designCommits(Schema.decodeUnknownSync(CanvasCommits)(data).reviewDirections.canvas.commits, day)

type Canvas = ReturnType<typeof decode>

/** Parts the design draws for a file: File zoom's ranges for its file, Cluster zoom's rows for the rest. */
const partsOf = (canvas: Canvas, path: string, newFile: boolean) => {
  if (path === canvas.fileZoom.file) {
    return canvas.fileZoom.fns.map((fn) => {
      const [start = 1, end = 1] = fn.range.split("–").map(Number)
      const moved = /^Moved from (.+)$/u.exec(fn.kind)
      // The Diff zoom draws connect() as lines 14 to 24; its line count stays the File zoom's.
      const lines = fn.n === canvas.diff.fn
        ? { start: canvas.diff.lines[0]?.n ?? start, end: canvas.diff.lines.at(-1)?.n ?? end }
        : { start, end }
      return {
        name: fn.n,
        kind: moved === null ? "added" : "moved_from",
        movedPath: moved === null ? null : `stage/${moved[1]}`,
        lines,
        added: fn.lines,
        removed: 0
      }
    })
  }
  const box = canvas.clusterA.boxes.find((entry) => entry.file === path)
  if (box === undefined) return null
  let line = 1
  return box.fns.map((fn) => {
    const moved = /^Moved to (.+)$/u.exec(fn.kind)
    if (moved !== null) {
      return {
        name: fn.n,
        kind: "moved_to",
        movedPath: `sync-worker/${moved[1]}`,
        lines: null,
        added: 0,
        removed: fn.lines
      }
    }
    const start = line
    line += fn.lines + 1
    return {
      name: fn.n,
      kind: newFile ? "added" : "modified",
      movedPath: null,
      lines: { start, end: start + fn.lines - 1 },
      added: fn.lines,
      removed: 0
    }
  })
}

const relations = { calls: "calls", imports: "imports", "moved from": "moved_from" } satisfies Record<
  string,
  "calls" | "imports" | "moved_from"
>

interface EdgeParts {
  readonly fromPart: string | null
  readonly toPart: string | null
}

/** Cluster boxes are 52 px of header, 38 px per function row and a 6 px foot; a row's centre is 17 px into it. */
const rowAt = (canvas: Canvas, path: string, x: number, y: number): string | null => {
  const box = canvas.clusterA.boxes.find((entry) => entry.file === path)
  if (box === undefined || (x !== box.x && x !== box.x + box.w)) return null
  const row = (y - box.y - 52 - 17) / 38
  return Number.isInteger(row) ? box.fns[row]?.n ?? null : null
}

/** A cluster line that ends on a function row's centre names that function. */
const drawnParts = (canvas: Canvas, from: string, to: string): EdgeParts => {
  const inside = (path: string, x: number, y: number) => {
    const box = canvas.clusterA.boxes.find((entry) => entry.file === path)
    if (box === undefined) return false
    const h = 52 + box.fns.length * 38 + 6
    return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + h
  }
  const line = canvas.clusterA.lines.find(({ p: [x1, y1, x2, y2], rel }) =>
    rel !== null && inside(from, x1, y1) && inside(to, x2, y2)
  )
  if (line === undefined) return { fromPart: null, toPart: null }
  const [x1, y1, x2, y2] = line.p
  return { fromPart: rowAt(canvas, from, x1, y1), toPart: rowAt(canvas, to, x2, y2) }
}

const stubFile = (canvas: Canvas, label: string): string | undefined => {
  const name = label.split(",")[0] ?? label
  return canvas.files.find((file) => file.path === name || file.path.endsWith(`/${name}`))?.path
}

/** A stub's phrase names the parts it joins: "A() calls B()", "A() moved into B()" or "imports B()". */
const phrasedParts = (canvas: Canvas, from: string, to: string): EdgeParts => {
  const boxes = canvas.clusterA.boxes.map((box) => box.file)
  const groups = [
    { drawn: boxes, stubs: canvas.clusterA.stubs },
    { drawn: [canvas.fileZoom.file], stubs: canvas.fileZoom.stubs },
    { drawn: [canvas.diff.file], stubs: canvas.diff.stubs }
  ]
  for (const group of groups) {
    for (const stub of group.stubs) {
      const file = stubFile(canvas, stub.label)
      const joins = (file === from && group.drawn.includes(to)) || (file === to && group.drawn.includes(from))
      if (!joins) continue
      const joined = /^(\S+\(\)) (?:calls|moved into) (\S+\(\))/u.exec(stub.line)
      if (joined !== null) return { fromPart: joined[1] ?? null, toPart: joined[2] ?? null }
      const imported = file === from ? /^imports (\S+\(\))/u.exec(stub.line) : null
      if (imported !== null) return { fromPart: null, toPart: imported[1] ?? null }
    }
  }
  return { fromPart: null, toPart: null }
}

const canvasGraph = (canvas: Canvas, state: CanvasState) => {
  const files = canvas.files.map((file) => {
    const newFile = file.rem === 0
    const parts = partsOf(canvas, file.path, newFile)
    return {
      path: file.path,
      status: newFile ? "added" : "modified",
      previousPath: null,
      added: file.add,
      removed: file.rem,
      parts: parts === null ? { _tag: "NotRecorded" } : { _tag: "Recorded", items: parts }
    }
  })
  const edges = canvas.edges.map((edge) => {
    const parts = drawnParts(canvas, edge.from, edge.to)
    const phrased = phrasedParts(canvas, edge.from, edge.to)
    return {
      from: edge.from,
      to: edge.to,
      relation: relations[edge.rel],
      fromPart: parts.fromPart ?? phrased.fromPart,
      toPart: parts.toPart ?? phrased.toPart
    }
  })
  const graph = {
    headRevision: full(canvas.pr.head),
    files,
    dependencies: state === "no-dependency-data"
      ? { _tag: "NotRecorded", language: "TypeScript" }
      : { _tag: "Recorded", edges },
    partitions: {
      _tag: "Recorded",
      items: canvas.partitions.map((partition) => ({
        id: partition.id,
        title: partition.title,
        why: partition.why,
        files: canvas.files.filter((file) => file.partition === partition.id).map((file) => file.path)
      }))
    }
  }
  if (state !== "map-building") return { _tag: "Ready", graph }
  const placed = /(\d+) of (\d+) files$/u.exec(canvas.building.line)
  return {
    _tag: "Building",
    headRevision: full(canvas.pr.head),
    placed: Number(placed?.[1] ?? 0),
    total: Number(placed?.[2] ?? files.length),
    files
  }
}

const lifeOf = (canvas: Canvas, life: string, raised: string | undefined) => {
  if (life === "New") return { _tag: "New" }
  const fixed = /^Fixed at (\S+)$/u.exec(life)
  if (fixed !== null) return { _tag: "Fixed", head: fixed[1] }
  const stamp = raised === undefined ? null : /^Raised (\d{2}:\d{2}) on (\S+),/u.exec(raised)
  return {
    _tag: "StillOpen",
    raisedAt: at(stamp?.[1] ?? canvas.pr.lastLook),
    raisedHead: stamp?.[2] ?? canvas.pr.head
  }
}

const failingTest = (canvas: Canvas) => {
  const test = /: (.+)$/u.exec(canvas.pr.check.result)?.[1] ?? canvas.pr.check.result
  return { check: canvas.pr.check.name, file: canvas.pr.check.file, test }
}

const canvasContext = (canvas: Canvas) => {
  const byPath = new Map(canvas.files.map((file) => [file.path, file]))
  const changed = canvas.files.filter((file) => file.changed === true).map((file) => file.path)
  const lastHead = canvas.pr.commitsSince[0]
  return {
    lastLook: {
      _tag: "Recorded",
      at: at(canvas.pr.lastLook),
      head: lastHead?.sha ?? canvas.pr.head,
      commitsSince: canvas.pr.commitsSince.length,
      changedFiles: changed
    },
    readingPath: {
      _tag: "Recorded",
      chapters: canvas.readingPath.chapters.map((chapter) => ({
        partition: canvas.partitions.some((partition) => partition.id === chapter.id) ? chapter.id : null,
        title: chapter.title,
        why: chapter.why,
        files: canvas.readingPath.order.filter((path) => {
          const file = byPath.get(path)
          return canvas.partitions.some((partition) => partition.id === chapter.id)
            ? file?.partition === chapter.id
            : file?.partition === null
        })
      })),
      read: canvas.readingPath.read,
      current: canvas.readingPath.current
    },
    findings: {
      _tag: "Recorded",
      notes: Object.fromEntries(
        Object.values(canvas.findings).map((finding) => [finding.id, {
          life: lifeOf(canvas, finding.life, finding.raised),
          evidence: finding.id === "F1" ? failingTest(canvas) : null
        }])
      )
    },
    tests: { _tag: "Recorded", failing: [failingTest(canvas)] }
  }
}

/** Findings anchor where the design pins them: F1 between lines 16 and 17, others on their function's lines. */
const findingLine = (canvas: Canvas, file: string, fn: string): number | null => {
  if (file === canvas.diff.file && fn === canvas.diff.fn) return 16
  const newFile = canvas.files.find((entry) => entry.path === file)?.rem === 0
  const part = partsOf(canvas, file, newFile)?.find((entry) => entry.name === fn)
  return part?.lines === null || part?.lines === undefined ? null : part.lines.start + 1
}

export const makeCanvasReadings = (data: Fixture["data"], state: CanvasState = "overview") => {
  const canvas = decode(data)
  const observedAt = at("14:24")
  const reviewedAt = at(/(\d{2}:\d{2})$/u.exec(canvas.pr.review)?.[1] ?? "14:22")
  const reviewer = canvas.pr.review.split(" ")[0] ?? "review"
  const number = canvas.pr.number.slice(1)
  const hostCount = Number(canvas.screen.shell.hosts.label.split(" ")[0])
  const hubHost = canvas.screen.shell.session.title.replace(/^Session on /u, "")
  const shell = makeShellReadings({ hubHost, hostCount, badge: canvas.screen.approvals.badge, observedAt })
  const item = {
    ref: CANVAS_REFERENCE,
    id: number,
    repository: canvas.pr.repo,
    title: canvas.pr.title,
    author: "pair-codex",
    status: "OPEN",
    approval: "waiting",
    createdAt: observedAt,
    updatedAt: observedAt,
    observedAt
  }
  const detail = Schema.decodeUnknownSync(CodeDetail)({
    _tag: "Ready",
    item,
    description: "",
    sourceBranch: canvas.pr.branch,
    destinationBranch: canvas.pr.base
  })
  const queue = Schema.decodeUnknownSync(CodeQueue)({ _tag: "Ready", observedAt, more: false, items: [item] })
  const diff = {
    pullRequestId: number,
    revisionId: `revision-${number}`,
    baseCommit: full(canvas.pr.commitsSince[0]?.sha ?? "0000000"),
    headCommit: full(canvas.pr.head),
    readAt: observedAt,
    cacheUpdatedAt: observedAt,
    files: canvas.files.map((file, index) => ({
      index,
      status: file.rem === 0 ? "added" : "modified",
      path: file.path,
      previousPath: null,
      beforeMode: file.rem === 0 ? null : "100644",
      afterMode: "100644"
    }))
  }
  const identity = {
    namespace: "codecommit",
    subjectId: CANVAS_REFERENCE,
    revisionId: diff.revisionId,
    baseRevision: diff.baseCommit,
    headRevision: diff.headCommit
  }
  const threads = Object.values(canvas.findings).map((finding) => {
    const line = findingLine(canvas, finding.file, finding.fn)
    const fixed = /^Fixed at (\S+)$/u.exec(finding.life)
    return {
      id: finding.id,
      source: "agent",
      resolved: false,
      messages: [],
      anchor: line === null
        ? { _tag: "File", path: finding.file, outdated: false }
        : { _tag: "Line", path: finding.file, line, side: "after", outdated: false },
      finding: {
        severity: finding.p,
        axis: null,
        confidence: null,
        claim: finding.title,
        summary: finding.body ?? null,
        why: finding.body ?? "",
        recommendation: "",
        verification: "",
        requirement: null,
        patch: null,
        disposition: fixed === null ? { _tag: "Open" } : { _tag: "FixedVerify", commit: fixed[1] }
      }
    }
  })
  const review = Schema.decodeUnknownSync(CodeReviewResult)({
    _tag: "Ready",
    reading: {
      diff,
      workspace: {
        identity,
        observedAt,
        run: {
          _tag: "Ready",
          run: {
            id: "run-fixture",
            identity,
            profile: {
              id: reviewer,
              name: reviewer,
              kind: "security",
              provider: "fixture",
              harness: "fixture",
              model: "fixture",
              skillIds: []
            },
            kind: "security",
            completedAt: reviewedAt,
            summary: "",
            explanation: null,
            risks: null,
            focus: null,
            rules: null,
            threads
          }
        },
        conversations: { _tag: "Unavailable", reason: "not_cached" },
        checks: {
          _tag: "Ready",
          observedAt,
          items: [{ id: canvas.pr.check.name, name: canvas.pr.check.name, state: "failed", logHref: null }]
        }
      }
    }
  })
  const canvasResult = Schema.decodeUnknownSync(CodeCanvasResult, { onExcessProperty: "error" })({
    _tag: "Ready",
    reading: { graph: canvasGraph(canvas, state), context: canvasContext(canvas) }
  })
  const diffResult = Schema.decodeUnknownSync(CodeDiffResult)({ _tag: "Ready", diff })
  const diffFile = canvas.files.findIndex((file) => file.path === canvas.diff.file)
  const last = canvas.diff.lines.at(-1)?.n ?? 0
  const lines = Array.from(
    { length: last },
    (_, index) => canvas.diff.lines.find((line) => line.n === index + 1)?.c ?? ""
  )
  const content = Schema.decodeUnknownSync(CodeDiffContentResult)({
    _tag: "Ready",
    content: {
      fileIndex: diffFile,
      revisionId: diff.revisionId,
      state: "text",
      before: null,
      after: `${lines.join("\n")}\n`
    }
  })
  return {
    ...shell,
    queue,
    detail,
    review,
    canvas: canvasResult,
    diff: diffResult,
    diffFile,
    content,
    commits: canvasCommits(data)
  }
}
