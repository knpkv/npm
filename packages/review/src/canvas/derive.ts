/** Pure views over a canvas reading: risk, marks, modules, reading order and arrow-key neighbours. @module */
import { type ReviewSeverity, reviewSeverityOrder } from "../model.js"
import { reviewRunReadingForWorkspace } from "../workspace-run-reading.js"
import type { ReviewWorkspace } from "../workspace.js"
import {
  type CanvasFile,
  type CanvasGraph,
  canvasModuleOf,
  type CanvasPart,
  type CanvasReadingPath,
  type CanvasReviewContext
} from "./model.js"

/** An open finding from the review run on the exact reviewed head, anchored to a file of this change. */
export interface CanvasFinding {
  readonly id: string
  readonly severity: ReviewSeverity
  readonly title: string
  readonly body: string
  readonly path: string
  /** Head-side line; null for a finding about the whole file. */
  readonly line: number | null
}

export type CanvasRisk = "high" | "medium" | "low"
export type CanvasMark = "failing" | "changed"

export interface CanvasFileView {
  readonly path: string
  readonly name: string
  readonly module: string
  readonly partition: string | null
  readonly added: number
  readonly removed: number
  readonly risk: CanvasRisk
  readonly marks: ReadonlyArray<CanvasMark>
  /** Failing test cases in this file, from the reviewed head's checks. */
  readonly failing: number
  readonly badges: ReadonlyArray<ReviewSeverity>
  readonly parts: ReadonlyArray<CanvasPart> | null
  readonly status: CanvasFile["status"]
}

export interface CanvasModule {
  readonly id: string
  readonly files: ReadonlyArray<CanvasFileView>
}

const severityRank = (severity: ReviewSeverity): number => reviewSeverityOrder.indexOf(severity)
const blocking = new Set<ReviewSeverity>(["P0", "P1", "P2"])

export const canvasBaseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

/**
 * Findings the canvas places: agent findings of a run on this exact head that are still open.
 * A run on another revision, or no run, places none; the review view explains why.
 */
export const canvasFindings = (workspace: ReviewWorkspace): ReadonlyArray<CanvasFinding> => {
  const reading = reviewRunReadingForWorkspace(workspace)
  if (reading._tag !== "Current") return []
  return reading.run.threads.flatMap((thread) => {
    const finding = thread.finding
    if (finding === null || finding.disposition._tag !== "Open" || thread.resolved) return []
    if (thread.anchor._tag === "Unanchored" || thread.anchor.outdated) return []
    const line = thread.anchor._tag === "Line" && thread.anchor.side === "after" ? thread.anchor.line : null
    return [{
      id: thread.id,
      severity: finding.severity,
      title: finding.claim,
      body: finding.summary ?? finding.why,
      path: thread.anchor.path,
      line
    }]
  })
}

/** Box width in canvas pixels: room for the name, wider for bigger changes. */
export const canvasNodeWidth = (name: string, changedLines: number): number =>
  Math.min(220, Math.round(Math.max(22 + 6.6 * name.length, 96 + 0.3 * changedLines)))

const riskOf = (changed: number, badges: ReadonlyArray<ReviewSeverity>): CanvasRisk =>
  changed >= 90 || badges.some((severity) => blocking.has(severity)) ? "high" : changed >= 40 ? "medium" : "low"

/** Per-file view in diff order. Unrecorded sources add no marks. */
export const canvasFiles = (
  graph: CanvasGraph,
  context: CanvasReviewContext,
  findings: ReadonlyArray<CanvasFinding>
): ReadonlyArray<CanvasFileView> => {
  const partitionOf = new Map(
    graph.partitions._tag === "Recorded"
      ? graph.partitions.items.flatMap((partition) =>
        partition.files.map((path): readonly [string, string] => [path, partition.id])
      )
      : []
  )
  const failures = context.tests._tag === "Recorded" ? context.tests.failing : []
  const changed = new Set(context.lastLook._tag === "Recorded" ? context.lastLook.changedFiles : [])
  return graph.files.map((file) => {
    const badges = findings
      .filter((finding) => finding.path === file.path)
      .map((finding) => finding.severity)
      .sort((left, right) => severityRank(left) - severityRank(right))
    const failing = failures.filter((test) => test.file === file.path).length
    const marks: Array<CanvasMark> = []
    if (failing > 0) marks.push("failing")
    if (changed.has(file.path)) marks.push("changed")
    return {
      path: file.path,
      name: canvasBaseName(file.path),
      module: canvasModuleOf(file.path),
      partition: partitionOf.get(file.path) ?? null,
      added: file.added,
      removed: file.removed,
      risk: riskOf(file.added + file.removed, badges),
      marks,
      failing,
      badges,
      parts: file.parts._tag === "Recorded" ? file.parts.items : null,
      status: file.status
    }
  })
}

/** Modules in the order their first file appears in the diff. */
export const canvasModules = (files: ReadonlyArray<CanvasFileView>): ReadonlyArray<CanvasModule> => {
  const modules = new Map<string, Array<CanvasFileView>>()
  for (const file of files) {
    const list = modules.get(file.module)
    if (list === undefined) modules.set(file.module, [file])
    else list.push(file)
  }
  return Array.from(modules, ([id, members]) => ({ id, files: members }))
}

const riskRank = { high: 0, medium: 1, low: 2 } satisfies Record<CanvasRisk, number>

/**
 * The order to read files in: the recorded reading path, then any files it leaves out.
 * Without a path: riskiest first, then the most severe finding, then the biggest change, then the path.
 */
export const readingOrder = (
  files: ReadonlyArray<CanvasFileView>,
  path: CanvasReadingPath
): ReadonlyArray<string> => {
  const fallback = [...files].sort((left, right) =>
    riskRank[left.risk] - riskRank[right.risk] ||
    (left.badges[0] === undefined ? 9 : severityRank(left.badges[0])) -
      (right.badges[0] === undefined ? 9 : severityRank(right.badges[0])) ||
    (right.added + right.removed) - (left.added + left.removed) ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  ).map((file) => file.path)
  if (path._tag !== "Recorded") return fallback
  const listed = path.chapters.flatMap((chapter) => chapter.files)
  const seen = new Set(listed)
  return [...listed, ...fallback.filter((file) => !seen.has(file))]
}

export type CanvasArrow = "up" | "down" | "left" | "right"
export interface CanvasPoint {
  readonly x: number
  readonly y: number
}

const arrowAngle = { right: 0, down: 90, left: 180, up: 270 } satisfies Record<CanvasArrow, number>
const arrows: ReadonlyArray<CanvasArrow> = ["right", "down", "left", "up"]

/** Built one arrow at a time, then returned as the read-only targets. */
interface ArrowTargetsDraft {
  up?: string
  down?: string
  left?: string
  right?: string
}

/** The neighbour each arrow key moves to; an arrow with no neighbour is absent. */
export interface CanvasArrowTargets {
  readonly up?: string
  readonly down?: string
  readonly left?: string
  readonly right?: string
}

/**
 * Give each arrow key at most one neighbour: the pairing with the smallest angle wins, and each neighbour is used
 * once. Screen coordinates, so "down" is +y. Ties keep input order.
 */
export const arrowNeighbours = (
  from: CanvasPoint,
  neighbours: ReadonlyArray<CanvasPoint & { readonly path: string }>
): CanvasArrowTargets => {
  const pairs = neighbours.flatMap((neighbour, index) => {
    const angle = (Math.atan2(neighbour.y - from.y, neighbour.x - from.x) * 180) / Math.PI
    return arrows.map((arrow) => {
      const delta = Math.abs(((angle - arrowAngle[arrow] + 540) % 360) - 180)
      return { arrow, path: neighbour.path, delta, index }
    })
  }).filter((pair) => pair.delta < 135).sort((left, right) => left.delta - right.delta || left.index - right.index)
  const chosen = new Map<CanvasArrow, string>()
  const used = new Set<string>()
  for (const pair of pairs) {
    if (chosen.has(pair.arrow) || used.has(pair.path)) continue
    chosen.set(pair.arrow, pair.path)
    used.add(pair.path)
  }
  const targets: ArrowTargetsDraft = {}
  for (const [arrow, path] of chosen) targets[arrow] = path
  return targets
}
