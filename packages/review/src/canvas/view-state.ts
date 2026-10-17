/** Pure zoom, focus and panel transitions for the canvas, and the keys that drive them. @module */
import {
  arrowNeighbours,
  type CanvasArrow,
  type CanvasArrowTargets,
  canvasFiles,
  type CanvasFileView,
  type CanvasFinding,
  readingOrder
} from "./derive.js"
import {
  clusterMembers,
  clusterOf,
  layoutCluster,
  layoutOverview,
  orderedParts,
  type OverviewScene,
  type Rect
} from "./layout.js"
import type { CanvasGraph, CanvasGraphReading, CanvasReviewContext } from "./model.js"

export type CanvasLevel = "overview" | "cluster" | "file" | "diff"
export const canvasLevels: ReadonlyArray<CanvasLevel> = ["overview", "cluster", "file", "diff"]

export interface CanvasViewState {
  readonly level: CanvasLevel
  /** The focused file; it stays focused across zoom levels and the Files list. */
  readonly focus: string
  /** The focused part at File and Diff zoom. */
  readonly part: string | null
  /** Keyboard use shows the focus ring, the key panel and the focused node's edges. */
  readonly keyboard: boolean
  readonly panel: "canvas" | "files"
}

export type CanvasCommand =
  | { readonly _tag: "ZoomIn" }
  | { readonly _tag: "ZoomOut" }
  | { readonly _tag: "Fit" }
  | { readonly _tag: "Move"; readonly arrow: CanvasArrow }
  | { readonly _tag: "Focus"; readonly path: string }
  | { readonly _tag: "FocusPart"; readonly part: string }
  | { readonly _tag: "Level"; readonly level: CanvasLevel }
  | { readonly _tag: "TogglePanel" }
  | { readonly _tag: "Keyboard"; readonly on: boolean }
  | { readonly _tag: "Search" }

/** Everything the transitions read, derived once per reading. */
export interface CanvasWorld {
  /** False while the map is building: the Files list works, zoom does not. */
  readonly ready: boolean
  readonly graph: CanvasGraph
  readonly files: ReadonlyArray<CanvasFileView>
  readonly findings: ReadonlyArray<CanvasFinding>
  readonly order: ReadonlyArray<string>
  readonly overview: OverviewScene
}

export const makeCanvasWorld = (
  graph: CanvasGraph,
  context: CanvasReviewContext,
  findings: ReadonlyArray<CanvasFinding>
): CanvasWorld => {
  const files = canvasFiles(graph, context, findings)
  return {
    ready: true,
    graph,
    files,
    findings,
    order: readingOrder(files, context.readingPath),
    overview: layoutOverview(graph, files)
  }
}

/** While the map builds, its files are known but nothing is placed: the world lists them and is not ready. */
export const canvasWorldOf = (
  reading: CanvasGraphReading,
  context: CanvasReviewContext,
  findings: ReadonlyArray<CanvasFinding>
): CanvasWorld =>
  reading._tag === "Ready"
    ? makeCanvasWorld(reading.graph, context, findings)
    : {
      ...makeCanvasWorld(
        {
          headRevision: reading.headRevision,
          files: reading.files,
          dependencies: { _tag: "NotRecorded", language: null },
          partitions: { _tag: "NotRecorded" }
        },
        context,
        findings
      ),
      ready: false
    }

export const initialCanvasView = (world: CanvasWorld): CanvasViewState => ({
  level: "overview",
  focus: world.order[0] ?? "",
  part: null,
  keyboard: false,
  panel: "canvas"
})

const partsWithLines = (world: CanvasWorld, path: string) =>
  orderedParts(world.files.find((file) => file.path === path)?.parts ?? []).filter((part) => part.lines !== null)

/** Start File zoom on the part holding the most severe finding, else the first part still in the head. */
const defaultPart = (world: CanvasWorld, path: string): string | null => {
  const parts = partsWithLines(world, path)
  const pinned = world.findings
    .filter((finding) => finding.path === path && finding.line !== null)
    .flatMap((finding) => {
      const part = parts.find((candidate) =>
        candidate.lines !== null && finding.line !== null && finding.line >= candidate.lines.start &&
        finding.line <= candidate.lines.end
      )
      return part === undefined ? [] : [part.name]
    })[0]
  return pinned ?? parts[0]?.name ?? null
}

const centers = (rects: ReadonlyArray<Rect & { readonly path: string }>) =>
  new Map(rects.map((rect) => [rect.path, { path: rect.path, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }]))

/** Arrow targets from the focused file: along its edges, or to the nearest box when there are no edges. */
export const canvasArrowTargets = (
  world: CanvasWorld,
  state: CanvasViewState
): CanvasArrowTargets => {
  const target = state.level === "cluster" ? clusterOf(world.graph, world.files, state.focus) : null
  const rects = target === null ? world.overview.nodes : layoutCluster(world.graph, world.files, target).boxes
  const points = centers(rects)
  const from = points.get(state.focus)
  if (from === undefined) return {}
  const members = target === null ? null : new Set(clusterMembers(world.files, target).map((file) => file.path))
  const edges = world.graph.dependencies._tag === "Recorded" ? world.graph.dependencies.edges : null
  const linked = edges === null
    ? Array.from(points.keys()).filter((path) => path !== state.focus)
    : edges.flatMap((edge) => edge.from === state.focus ? [edge.to] : edge.to === state.focus ? [edge.from] : [])
  const neighbours = Array.from(new Set(linked)).flatMap((path) => {
    const point = points.get(path)
    return point === undefined || (members !== null && !members.has(path)) ? [] : [point]
  })
  return arrowNeighbours(from, neighbours)
}

const atLevel = (world: CanvasWorld, state: CanvasViewState, level: CanvasLevel): CanvasViewState => {
  if (!world.ready || level === state.level) return state
  if (level === "overview") return { ...state, level, part: null }
  if (level === "cluster") {
    return clusterOf(world.graph, world.files, state.focus) === null ? state : { ...state, level, part: null }
  }
  const part = state.part ?? defaultPart(world, state.focus)
  if (level === "file") return { ...state, level, part }
  return part === null ? state : { ...state, level, part }
}

const deeper = { overview: "cluster", cluster: "file", file: "diff", diff: "diff" } satisfies Record<
  CanvasLevel,
  CanvasLevel
>
const shallower = { overview: "overview", cluster: "overview", file: "cluster", diff: "file" } satisfies Record<
  CanvasLevel,
  CanvasLevel
>

export const reduceCanvasView = (
  world: CanvasWorld,
  state: CanvasViewState,
  command: CanvasCommand
): CanvasViewState => {
  switch (command._tag) {
    case "ZoomIn":
      return atLevel(world, state, deeper[state.level])
    case "ZoomOut":
      return atLevel(world, state, shallower[state.level])
    case "Fit":
      return atLevel(world, state, "overview")
    case "Level":
      return atLevel(world, state, command.level)
    case "Move": {
      if (state.level === "file" || state.level === "diff") {
        if (state.level === "diff" || (command.arrow !== "up" && command.arrow !== "down")) return state
        const parts = partsWithLines(world, state.focus)
        const index = parts.findIndex((part) => part.name === state.part)
        const next = parts[index + (command.arrow === "down" ? 1 : -1)]
        return next === undefined ? state : { ...state, part: next.name }
      }
      const target = canvasArrowTargets(world, state)[command.arrow]
      return target === undefined ? state : { ...state, focus: target }
    }
    case "Focus":
      return world.files.some((file) => file.path === command.path) && command.path !== state.focus
        ? { ...state, focus: command.path, part: null }
        : state
    case "FocusPart":
      return partsWithLines(world, state.focus).some((part) => part.name === command.part)
        ? { ...state, part: command.part }
        : state
    case "TogglePanel":
      return { ...state, panel: state.panel === "canvas" ? "files" : "canvas" }
    case "Keyboard":
      return state.keyboard === command.on ? state : { ...state, keyboard: command.on }
    case "Search":
      return state
  }
}

const keys = new Map<string, CanvasCommand>([
  ["ArrowUp", { _tag: "Move", arrow: "up" }],
  ["ArrowDown", { _tag: "Move", arrow: "down" }],
  ["ArrowLeft", { _tag: "Move", arrow: "left" }],
  ["ArrowRight", { _tag: "Move", arrow: "right" }],
  ["Enter", { _tag: "ZoomIn" }],
  ["+", { _tag: "ZoomIn" }],
  ["=", { _tag: "ZoomIn" }],
  ["Escape", { _tag: "ZoomOut" }],
  ["-", { _tag: "ZoomOut" }],
  ["−", { _tag: "ZoomOut" }],
  ["f", { _tag: "Fit" }],
  ["l", { _tag: "TogglePanel" }],
  ["/", { _tag: "Search" }],
  ["1", { _tag: "Level", level: "overview" }],
  ["2", { _tag: "Level", level: "cluster" }],
  ["3", { _tag: "Level", level: "file" }],
  ["4", { _tag: "Level", level: "diff" }]
])

/** The canvas's own keys. Anything else stays with the page. */
export const canvasKeyCommand = (key: string): CanvasCommand | null => keys.get(key) ?? null
