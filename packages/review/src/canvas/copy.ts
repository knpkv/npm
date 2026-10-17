/** Every sentence the canvas generates from its reading. Plain English, en-GB times, no invented facts. @module */
import { type ReviewSeverity, reviewSeverityOrder } from "../model.js"
import { type CanvasArrow, canvasBaseName, type CanvasFileView, type CanvasFinding, type CanvasRisk } from "./derive.js"
import { clusterMembers, clusterOf, layoutCluster, layoutDiff, layoutFile } from "./layout.js"
import type { CanvasFindingNote, CanvasFindingNotes, CanvasGraph, CanvasLastLook } from "./model.js"
import { canvasArrowTargets, type CanvasLevel, type CanvasViewState, type CanvasWorld } from "./view-state.js"

/** Hour and minute in the viewer's zone, or the given one. */
export const timeOfDay = (timestamp: number, timeZone?: string): string => {
  const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
  if (timeZone !== undefined) options.timeZone = timeZone
  return new Intl.DateTimeFormat("en-GB", options).format(timestamp)
}

/** "a", "a and b", "a, b and c". */
export const listWords = (items: ReadonlyArray<string>): string =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`

const plural = (count: number, one: string, many: string = `${one}s`): string => `${count} ${count === 1 ? one : many}`

/** "+24 −118", with a true minus sign. */
export const sizeWords = (file: { readonly added: number; readonly removed: number }): string =>
  `+${file.added} −${file.removed}`

export const riskWords = { high: "High risk", medium: "Medium risk", low: "Low risk" } satisfies Record<
  CanvasRisk,
  string
>

const totals = (files: ReadonlyArray<CanvasFileView>) => ({
  added: files.reduce((sum, file) => sum + file.added, 0),
  removed: files.reduce((sum, file) => sum + file.removed, 0)
})

/** "14 files in 4 modules, +612 −240". */
export const changeLine = (files: ReadonlyArray<CanvasFileView>): string => {
  const modules = new Set(files.map((file) => file.module)).size
  return `${plural(files.length, "file")} in ${plural(modules, "module")}, ${sizeWords(totals(files))}`
}

/** "14 files, +612 −240." for the phone summary. */
export const phoneChangeLine = (files: ReadonlyArray<CanvasFileView>): string =>
  `${plural(files.length, "file")}, ${sizeWords(totals(files))}.`

const severityCounts = (findings: ReadonlyArray<{ readonly severity: ReviewSeverity }>): string =>
  reviewSeverityOrder
    .flatMap((severity) => {
      const count = findings.filter((finding) => finding.severity === severity).length
      return count === 0 ? [] : [`${count} ${severity}`]
    })
    .join(", ")

/** "sec-cc review, 14:22: 1 P1, 2 P2, 1 P3". */
export const reviewLine = (
  reviewer: string,
  completedAt: number,
  findings: ReadonlyArray<CanvasFinding>,
  timeZone?: string
): string =>
  `${reviewer} review, ${timeOfDay(completedAt, timeZone)}: ${
    findings.length === 0 ? "no open findings" : severityCounts(findings)
  }`

export const checkWords = (failed: ReadonlyArray<string>): string => `${plural(failed.length, "check")} failed`

/** "You looked at 13:20. 2 commits since, 4 files changed." Null when no look was recorded. */
export const sinceLine = (lastLook: CanvasLastLook, timeZone?: string): string | null => {
  if (lastLook._tag !== "Recorded") return null
  const at = `You looked at ${timeOfDay(lastLook.at, timeZone)}.`
  if (lastLook.commitsSince === 0) return `${at} No commits since.`
  return `${at} ${plural(lastLook.commitsSince, "commit")} since, ${
    plural(lastLook.changedFiles.length, "file")
  } changed.`
}

/** The phone's shorter "You looked at 13:20. 2 commits since." */
export const phoneSinceLine = (lastLook: CanvasLastLook, timeZone?: string): string | null => {
  if (lastLook._tag !== "Recorded") return null
  const at = `You looked at ${timeOfDay(lastLook.at, timeZone)}.`
  return lastLook.commitsSince === 0
    ? `${at} No commits since.`
    : `${at} ${plural(lastLook.commitsSince, "commit")} since.`
}

export const levelNames = { overview: "Overview", cluster: "Cluster", file: "File", diff: "Diff" } satisfies Record<
  CanvasLevel,
  string
>

const partLines = (lines: { readonly start: number; readonly end: number } | null): string =>
  lines === null ? "" : lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start}–${lines.end}`

const clusterWords = (world: CanvasWorld, state: CanvasViewState) => {
  const target = clusterOf(world.graph, world.files, state.focus)
  if (target === null) return null
  const members = clusterMembers(world.files, target)
  return { target, members, name: target.kind === "partition" ? `partition ${target.id}` : `module ${target.id}` }
}

const focusedPart = (world: CanvasWorld, state: CanvasViewState) =>
  world.files.find((file) => file.path === state.focus)?.parts?.find((part) => part.name === state.part) ?? null

/** The line beside the zoom ladder. */
export const levelLine = (world: CanvasWorld, state: CanvasViewState): string => {
  if (!world.ready) return "Zoom opens when the map is ready"
  switch (state.level) {
    case "overview":
      return world.overview.mode === "modules" ? "Overview: files by module" : "Overview: the whole change"
    case "cluster": {
      const cluster = clusterWords(world, state)
      return cluster === null ? "Cluster" : `Cluster: ${cluster.name}, ${plural(cluster.members.length, "file")}`
    }
    case "file":
      return `File: ${state.focus}`
    case "diff": {
      const part = focusedPart(world, state)
      return part === null ? "Diff" : `Diff: ${part.name}, ${partLines(part.lines)}`
    }
  }
}

const findingAt = (world: CanvasWorld, id: string): CanvasFinding | undefined =>
  world.findings.find((finding) => finding.id === id)

/** The live status under the canvas. Building names its progress. */
export const statusLine = (
  world: CanvasWorld,
  state: CanvasViewState,
  building: { readonly placed: number; readonly total: number } | null
): string => {
  if (!world.ready) {
    return `Building the map: reading call and import relations, ${building?.placed ?? 0} of ${
      building?.total ?? world.files.length
    } files`
  }
  const files = plural(world.files.length, "file")
  switch (state.level) {
    case "overview": {
      if (world.overview.mode === "modules") {
        return `${files} placed by module. Cluster zoom opens a module; File and Diff zoom work as usual.`
      }
      const edges = world.graph.dependencies._tag === "Recorded" ? world.graph.dependencies.edges.length : 0
      const partitions = world.overview.bands.length
      return partitions === 0
        ? `${files}, ${plural(edges, "edge")} this change touches. Enter on a file zooms into its module.`
        : `${files}, ${plural(edges, "edge")} this change touches, ${
          plural(partitions, "partition")
        }. Enter on a partition zooms into it.`
    }
    case "cluster": {
      const cluster = clusterWords(world, state)
      if (cluster === null) return files
      const modules = Array.from(new Set(cluster.members.map((file) => file.module)))
      const head = `${cluster.name[0]?.toUpperCase() ?? ""}${cluster.name.slice(1)}, ${
        plural(cluster.members.length, "file")
      }${cluster.target.kind === "partition" ? ` in ${listWords(modules)}` : ""}.`
      const scene = layoutCluster(world.graph, world.files, cluster.target)
      const leads = Array.from(
        new Set(scene.stubs.map((stub) => {
          const file = world.files.find((entry) => entry.path === stub.path)
          return file === undefined ? stub.path : file.partition === null ? file.module : `partition ${file.partition}`
        }))
      )
      return leads.length === 0
        ? head
        : `${head} Faint stubs at the edge lead out of ${cluster.target.id}: ${
          listWords(leads.map((lead) => `to ${lead}`))
        }.`
    }
    case "file": {
      const scene = layoutFile(world.graph, world.files, world.findings, state.focus)
      const name = canvasBaseName(state.focus)
      return scene.rows.length === 0
        ? `${name}. Its changed parts were not read.`
        : `${name}, ${
          plural(scene.rows.length, "changed part")
        }. Callers on the left, callees on the right; each stub says where it leads.`
    }
    case "diff": {
      const part = state.part ?? ""
      const scene = layoutDiff(world.graph, world.files, world.findings, state.focus, part)
      const name = canvasBaseName(state.focus)
      const finds = scene.cards.flatMap((card) => {
        const finding = findingAt(world, card.finding)
        return finding === undefined ? [] : [`the ${finding.severity} between ${card.after} and ${card.after + 1}`]
      })
      const edges = [
        scene.left.length === 0
          ? null
          : `${listWords(scene.left.map((stub) => canvasBaseName(stub.path)))} on the left`,
        scene.right.length === 0
          ? null
          : `${listWords(scene.right.map((stub) => canvasBaseName(stub.path)))} on the right`,
        scene.next === null ? null : `${scene.next} below`
      ].filter((entry): entry is string => entry !== null)
      const head = `${partLines(scene.lines).replace(/^l/u, "L")} of ${name}${
        finds.length === 0 ? "" : `, ${listWords(finds)}`
      }.`
      return edges.length === 0 ? head : `${head} Neighbours stay at the edge: ${edges.join(", ")}.`
    }
  }
}

const lifeWords = (note: CanvasFindingNote | undefined): string =>
  note === undefined
    ? "open"
    : note.life._tag === "StillOpen"
    ? "still open"
    : note.life._tag === "New"
    ? "new"
    : "fixed"

const arrowGlyph = { up: "↑", left: "←", down: "↓", right: "→" } satisfies Record<CanvasArrow, string>
const arrowOrder: ReadonlyArray<CanvasArrow> = ["up", "left", "down", "right"]

/** "↑ worker.ts calls it": how the neighbour on one arrow meets the focused file. */
export const arrowPhrase = (world: CanvasWorld, focus: string, other: string): string => {
  const edges = world.graph.dependencies._tag === "Recorded" ? world.graph.dependencies.edges : []
  const edge = edges.find((entry) =>
    (entry.from === focus && entry.to === other) || (entry.from === other && entry.to === focus)
  )
  const name = canvasBaseName(other)
  if (edge === undefined) return name
  const verb = edge.relation === "moved_from" ? "moved into" : edge.relation
  return edge.from === other ? `${name} ${verb} it` : `it ${verb} ${name}`
}

/** "↑ worker.ts": the edge label shown on the canvas while a node has keyboard focus. */
export const arrowLabels = (world: CanvasWorld, state: CanvasViewState): ReadonlyMap<string, string> => {
  const targets = canvasArrowTargets(world, state)
  return new Map(
    arrowOrder.flatMap((arrow) => {
      const path = targets[arrow]
      if (path === undefined) return []
      const label: readonly [string, string] = [path, `${arrowGlyph[arrow]} ${canvasBaseName(path)}`]
      return [label]
    })
  )
}

/** The status line for the focused node: where it is, its state and where each arrow goes. */
export const focusDescription = (
  world: CanvasWorld,
  state: CanvasViewState,
  notes: CanvasFindingNotes = { _tag: "NotRecorded" }
): string => {
  const file = world.files.find((entry) => entry.path === state.focus)
  if (file === undefined) return ""
  const place = [file.name, file.module, ...(file.partition === null ? [] : [`partition ${file.partition}`])].join(", ")
  const findings = world.findings.filter((finding) => finding.path === file.path)
  const facts = [
    riskWords[file.risk],
    ...findings.map((finding) =>
      `${finding.severity} ${lifeWords(notes._tag === "Recorded" ? notes.notes[finding.id] : undefined)}`
    ),
    ...(file.marks.includes("failing") ? ["failing"] : []),
    ...(file.marks.includes("changed") ? ["changed since you looked"] : [])
  ]
  const edges = world.graph.dependencies._tag === "Recorded"
    ? world.graph.dependencies.edges.filter((edge) => edge.from === file.path || edge.to === file.path).length
    : 0
  const targets = canvasArrowTargets(world, state)
  const arrows = arrowOrder.flatMap((arrow) => {
    const path = targets[arrow]
    return path === undefined ? [] : [`${arrowGlyph[arrow]} ${arrowPhrase(world, file.path, path)}`]
  })
  const reach = edges === 0 ? "No edges." : `${plural(edges, "edge")}: ${arrows.join(", ")}.`
  return `${place}. ${facts.join(", ")}. ${reach}`
}

/** The notice above the module-only overview. */
export const noDependencyNotice = (graph: CanvasGraph, repository: string): string => {
  const language = graph.dependencies._tag === "NotRecorded" ? graph.dependencies.language : null
  const ids = graph.partitions._tag === "Recorded" ? graph.partitions.items.map((partition) => partition.id) : []
  return `Edges are missing: there’s no dependency data${
    language === null ? "" : ` for ${language}`
  } in ${repository} yet. Files are grouped by module only, so ${
    ids.length === 0 ? "partitions" : `partition${ids.length === 1 ? "" : "s"} ${listWords(ids)}`
  } can’t be drawn either.`
}

/** "Changed since 13:20" for legends and phone rows; null without a recorded look. */
export const changedSinceWords = (lastLook: CanvasLastLook, timeZone?: string): string | null =>
  lastLook._tag === "Recorded" ? `Changed since ${timeOfDay(lastLook.at, timeZone)}` : null

/** "New", "Still open" or "Fixed at 3b6d0a5"; null without a recorded note. */
export const findingLifeWords = (note: CanvasFindingNote | undefined): string | null => {
  if (note === undefined) return null
  switch (note.life._tag) {
    case "New":
      return "New"
    case "StillOpen":
      return "Still open"
    case "Fixed":
      return `Fixed at ${note.life.head}`
  }
}
