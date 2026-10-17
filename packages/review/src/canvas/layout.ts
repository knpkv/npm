/**
 * Deterministic canvas geometry. The same change lays out the same way on every head: positions depend only on
 * files, modules, partitions and edges, in diff order. Coordinates are canvas pixels in a 1016-wide frame; the view
 * scales the frame down to fit, never up.
 * @module
 */
import { reviewSeverityOrder } from "../model.js"
import { canvasBaseName, type CanvasFileView, type CanvasFinding, canvasModules, canvasNodeWidth } from "./derive.js"
import type { CanvasEdge, CanvasGraph, CanvasPart, CanvasRelation } from "./model.js"

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export const CANVAS_WIDTH = 1016
export const CANVAS_MIN_HEIGHT = 640
/** The minimap the view draws over the canvas's bottom-right corner, `inset` from both edges (see `.rc-minimap`). */
export const CANVAS_MINIMAP = {
  w: 168,
  h: 135,
  inset: 12
}
/** The changed part that holds a file's imports and type declarations. Listed after its functions. */
export const CANVAS_MODULE_PART = "imports and types"

/** A node is 46px tall with one 16px line per mark. */
export const canvasNodeHeight = (marks: number): number => 46 + 16 * marks

export interface SceneRegion extends Rect {
  readonly id: string
  readonly files: number
}

export interface SceneBand extends Rect {
  readonly id: string
  readonly title: string
  readonly files: number
  readonly tab: { readonly x: number; readonly y: number }
}

export interface SceneNode extends Rect {
  readonly path: string
}

export interface SceneLine {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly dash: boolean
  readonly from: string
  readonly to: string
  readonly relation: CanvasRelation
}

export interface OverviewScene {
  /** partitions: bands and edges. edges: edges without partitions. modules: no dependency data. */
  readonly mode: "partitions" | "edges" | "modules"
  readonly width: number
  readonly height: number
  readonly regions: ReadonlyArray<SceneRegion>
  readonly bands: ReadonlyArray<SceneBand>
  readonly nodes: ReadonlyArray<SceneNode>
  readonly lines: ReadonlyArray<SceneLine>
}

const NODE_GAP = 10
const LINE_GAP = 12
const CELL_MAX = 260
/** Modules outside every partition share a strip under the bands, beside the legend. */
const STRIP_MAX = 400
const STRIP_LEFT = 344
const STRIP_GAP = 20
const REGION_HEADER = 32
const REGION_INSET = 20
const COLUMN_GAP = 12
const BAND_PAD = 24
const ROW_GAP = 12
const TOP = 56
const LEFT = 16
/** Room under the drawing for the legend and the minimap, which sit on the canvas. */
const OVERLAY_RESERVE = 196

const centerOf = (rect: Rect): readonly [number, number] => [rect.x + rect.w / 2, rect.y + rect.h / 2]

/** Clip the segment between two box centres to each box's border. */
export const linkRects = (from: Rect, to: Rect): readonly [number, number, number, number] => {
  const clip = (rect: Rect, [cx, cy]: readonly [number, number], [tx, ty]: readonly [number, number]) => {
    const dx = tx - cx
    const dy = ty - cy
    const t = Math.min(
      dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(rect.w / 2 / dx),
      dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(rect.h / 2 / dy)
    )
    const point: readonly [number, number] = [cx + dx * t, cy + dy * t]
    return point
  }
  const a = centerOf(from)
  const b = centerOf(to)
  return [...clip(from, a, b), ...clip(to, b, a)]
}

const edgesOf = (graph: CanvasGraph): ReadonlyArray<CanvasEdge> =>
  graph.dependencies._tag === "Recorded" ? graph.dependencies.edges : []

/** One line per connected file pair, in first-edge order. A pair joined only by moves is dashed. */
const pairLines = (edges: ReadonlyArray<CanvasEdge>, rects: ReadonlyMap<string, Rect>): ReadonlyArray<SceneLine> => {
  const pairs = new Map<string, { from: string; to: string; relation: CanvasRelation; moved: boolean }>()
  for (const edge of edges) {
    const key = JSON.stringify([edge.from, edge.to])
    const known = pairs.get(key)
    if (known === undefined) {
      pairs.set(key, { from: edge.from, to: edge.to, relation: edge.relation, moved: edge.relation === "moved_from" })
    } else if (edge.relation !== "moved_from") pairs.set(key, { ...known, relation: edge.relation, moved: false })
  }
  return Array.from(pairs.values()).flatMap((pair) => {
    const from = rects.get(pair.from)
    const to = rects.get(pair.to)
    if (from === undefined || to === undefined) return []
    const [x1, y1, x2, y2] = linkRects(from, to)
    return [{ x1, y1, x2, y2, dash: pair.moved, from: pair.from, to: pair.to, relation: pair.relation }]
  })
}

interface Flow {
  readonly width: number
  readonly height: number
  readonly placed: ReadonlyArray<
    { readonly path: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  >
}

/** Fill rows left to right up to the cell width. */
const flow = (files: ReadonlyArray<CanvasFileView>, max: number = CELL_MAX): Flow => {
  const placed: Array<Flow["placed"][number]> = []
  let x = 0
  let y = 0
  let lineHeight = 0
  let width = 0
  for (const file of files) {
    const w = canvasNodeWidth(file.name, file.added + file.removed)
    const h = canvasNodeHeight(file.marks.length)
    if (x > 0 && x + w > max) {
      y += lineHeight + LINE_GAP
      x = 0
      lineHeight = 0
    }
    placed.push({ path: file.path, x, y, w, h })
    width = Math.max(width, x + w)
    lineHeight = Math.max(lineHeight, h)
    x += w + NODE_GAP
  }
  return { width, height: files.length === 0 ? 0 : y + lineHeight, placed }
}

const layoutModulesOnly = (files: ReadonlyArray<CanvasFileView>): OverviewScene => {
  const modules = canvasModules(files)
  const columns: Array<SceneRegion> = []
  const nodes: Array<SceneNode> = []
  modules.forEach((module, column) => {
    const x = LEFT + column * 250
    let y = 104
    for (const file of module.files) {
      const h = canvasNodeHeight(file.marks.length)
      nodes.push({
        path: file.path,
        x: x + 12,
        y,
        w: Math.min(canvasNodeWidth(file.name, file.added + file.removed) + 40, 214),
        h
      })
      y += Math.max(72, h + 10)
    }
    columns.push({ id: module.id, files: module.files.length, x, y: 64, w: 238, h: Math.max(336, y - 64 + 14) })
  })
  // Columns share the tallest one's height, so the row reads as one band.
  const tallest = Math.max(0, ...columns.map((region) => region.h))
  const regions = columns.map((region) => ({ ...region, h: tallest }))
  const right = Math.max(...regions.map((region) => region.x + region.w), 0)
  const bottom = Math.max(...regions.map((region) => region.y + region.h), 0)
  return {
    mode: "modules",
    // After the last column, keep the 12px gap the columns have between them.
    width: Math.max(CANVAS_WIDTH, right + 12),
    height: Math.max(CANVAS_MIN_HEIGHT, bottom + OVERLAY_RESERVE),
    regions,
    bands: [],
    nodes,
    lines: []
  }
}

/**
 * Modules are columns; partitions are rows, followed by one row for a column's files outside any partition. Each
 * cell flows its files in diff order. A module's region spans its first to last row; a partition's band spans its
 * columns. Modules with no partitioned file sit in a strip under the bands, starting beside the legend.
 */
export const layoutOverview = (graph: CanvasGraph, files: ReadonlyArray<CanvasFileView>): OverviewScene => {
  if (graph.dependencies._tag === "NotRecorded") return layoutModulesOnly(files)
  const partitions = graph.partitions._tag === "Recorded" ? graph.partitions.items : []
  const all = canvasModules(files)
  const striped = (module: (typeof all)[number]) =>
    partitions.length > 0 && module.files.every((file) => file.partition === null)
  const modules = all.filter((module) => !striped(module))
  const strip = all.filter(striped)
  const columnFiles = modules.flatMap((module) => module.files)
  const rowIds: ReadonlyArray<string | null> = [
    ...partitions.map((partition) => partition.id),
    ...(columnFiles.some((file) => file.partition === null) ? [null] : [])
  ]
  const cells = modules.map((module) =>
    rowIds.map((row) => flow(module.files.filter((file) => file.partition === row)))
  )
  const columnWidth = cells.map((column) => Math.max(100, ...column.map((cell) => cell.width)))
  const columnX: Array<number> = []
  columnWidth.reduce((x, width) => {
    columnX.push(x)
    return x + width + 2 * REGION_INSET + COLUMN_GAP
  }, LEFT)
  const firstRow = cells.map((column) => column.findIndex((cell) => cell.placed.length > 0))
  const lastRow = cells.map((column) =>
    column.length - 1 - [...column].reverse().findIndex((cell) => cell.placed.length > 0)
  )
  const rows: Array<{ top: number; content: number; bottom: number; banded: boolean }> = []
  let cursor = TOP + REGION_HEADER
  rowIds.forEach((row, index) => {
    if (index > 0 && firstRow.includes(index)) cursor += REGION_HEADER
    const banded = row !== null
    const height = Math.max(0, ...cells.map((column) => column[index]?.height ?? 0))
    const content = cursor + (banded ? BAND_PAD : 0)
    const bottom = content + height + (banded ? BAND_PAD : 0)
    rows.push({ top: cursor, content, bottom, banded })
    cursor = bottom + ROW_GAP
  })
  const nodes: Array<SceneNode> = []
  cells.forEach((column, columnIndex) =>
    column.forEach((cell, rowIndex) => {
      const row = rows[rowIndex]
      if (row === undefined) return
      for (const placed of cell.placed) {
        nodes.push({
          path: placed.path,
          x: (columnX[columnIndex] ?? 0) + REGION_INSET + placed.x,
          y: row.content + placed.y,
          w: placed.w,
          h: placed.h
        })
      }
    })
  )
  const regions = modules.map((module, index): SceneRegion => {
    const first = rows[firstRow[index] ?? 0]
    const last = rows[lastRow[index] ?? 0]
    const top = (first?.top ?? TOP) - REGION_HEADER
    return {
      id: module.id,
      files: module.files.length,
      x: columnX[index] ?? 0,
      y: top,
      w: (columnWidth[index] ?? 0) + 2 * REGION_INSET,
      h: (last?.bottom ?? top) + 8 - top
    }
  })
  const bands = partitions.flatMap((partition, rowIndex): ReadonlyArray<SceneBand> => {
    const row = rows[rowIndex]
    const columns = cells.flatMap((column, index) => (column[rowIndex]?.placed.length ?? 0) > 0 ? [index] : [])
    const first = columns[0]
    const last = columns.at(-1)
    if (row === undefined || first === undefined || last === undefined) return []
    const x = (columnX[first] ?? 0) + 8
    const right = (columnX[last] ?? 0) + (columnWidth[last] ?? 0) + 2 * REGION_INSET - 8
    const h = row.bottom - row.top
    return [{
      id: partition.id,
      title: partition.title,
      files: partition.files.length,
      x,
      y: row.top,
      w: right - x,
      h,
      tab: { x: 12, y: h - 11 }
    }]
  })
  const columnsBottom = Math.max(TOP, ...regions.map((region) => region.y + region.h))
  let stripX = STRIP_LEFT
  const stripTop = columnsBottom + STRIP_GAP
  for (const module of strip) {
    const cell = flow(module.files, STRIP_MAX)
    const w = cell.width + 24
    for (const placed of cell.placed) {
      nodes.push({ ...placed, x: stripX + 12 + placed.x, y: stripTop + REGION_HEADER + placed.y })
    }
    regions.push({
      id: module.id,
      files: module.files.length,
      x: stripX,
      y: stripTop,
      w,
      h: REGION_HEADER + cell.height + 16
    })
    stripX += w + COLUMN_GAP
  }
  const right = Math.max(...regions.map((region) => region.x + region.w))
  const stripBottom = Math.max(0, ...regions.slice(modules.length).map((region) => region.y + region.h))
  return {
    mode: partitions.length > 0 ? "partitions" : "edges",
    width: Math.max(CANVAS_WIDTH, right + LEFT),
    height: Math.max(CANVAS_MIN_HEIGHT, columnsBottom + OVERLAY_RESERVE, stripBottom + 14),
    regions,
    bands,
    nodes,
    lines: pairLines(edgesOf(graph), new Map(nodes.map((node) => [node.path, node])))
  }
}

export type ClusterTarget =
  | { readonly kind: "partition"; readonly id: string }
  | { readonly kind: "module"; readonly id: string }

/** A file zooms into its partition when partitions were recorded and it is in one, otherwise into its module. */
export const clusterOf = (
  _graph: CanvasGraph,
  files: ReadonlyArray<CanvasFileView>,
  path: string
): ClusterTarget | null => {
  const file = files.find((entry) => entry.path === path)
  if (file === undefined) return null
  return file.partition === null ? { kind: "module", id: file.module } : { kind: "partition", id: file.partition }
}

export const clusterMembers = (
  files: ReadonlyArray<CanvasFileView>,
  target: ClusterTarget
): ReadonlyArray<CanvasFileView> =>
  files.filter((file) => target.kind === "partition" ? file.partition === target.id : file.module === target.id)

export interface SceneBox extends Rect {
  readonly path: string
  readonly parts: ReadonlyArray<CanvasPart>
}

export interface SceneStub extends Rect {
  readonly path: string
  readonly label: string
  readonly line: string
  readonly failing: boolean
}

export interface ScenePoint {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly dash: boolean
  readonly faint: boolean
  readonly label: string | null
}

export interface ClusterScene {
  readonly width: number
  readonly height: number
  readonly target: ClusterTarget
  readonly band: SceneBand | null
  readonly boxes: ReadonlyArray<SceneBox>
  readonly stubs: ReadonlyArray<SceneStub>
  readonly lines: ReadonlyArray<ScenePoint>
}

const BOX_W = 290
const BOX_GAP = 196
const STUB_W = 168
const STUB_H = 48

/** Box height: a 52px header, one 38px row per part, 6px foot. */
export const canvasBoxHeight = (parts: number): number => 52 + parts * 38 + 6

/** Parts in reading order: functions by first line, then the module part, then parts gone from the head. */
export const orderedParts = (parts: ReadonlyArray<CanvasPart>): ReadonlyArray<CanvasPart> =>
  [...parts].sort((left, right) => {
    const rank = (part: CanvasPart) => part.lines === null ? 2 : part.name === CANVAS_MODULE_PART ? 1 : 0
    return rank(left) - rank(right) || (left.lines?.start ?? 0) - (right.lines?.start ?? 0)
  })

const relationWords = { imports: "imports", calls: "calls", moved_from: "moved from" } satisfies Record<
  CanvasRelation,
  string
>

const failingTests = (file: CanvasFileView | undefined): boolean => (file?.failing ?? 0) > 0

/** How an outside file meets the inside one, from the outside file's side. */
const stubLine = (edge: CanvasEdge, outside: string, file: CanvasFileView | undefined): string => {
  const incoming = edge.from === outside
  const phrase = edge.relation === "moved_from"
    ? `${edge.fromPart ?? canvasBaseName(edge.from)} moved into ${edge.toPart ?? canvasBaseName(edge.to)}`
    : edge.fromPart !== null && edge.toPart !== null
    ? `${edge.fromPart} ${edge.relation} ${edge.toPart}`
    : incoming
    ? `${edge.relation} ${edge.toPart ?? canvasBaseName(edge.to)}`
    : `${edge.relation === "imports" ? "imported by" : "called by"} ${edge.fromPart ?? canvasBaseName(edge.from)}`
  return file !== undefined && file.failing > 0 ? `${phrase}, ${file.failing} failing` : phrase
}

const partRow = (box: SceneBox, name: string | null): number =>
  name === null ? -1 : box.parts.findIndex((part) => part.name === name)
const rowCenter = (box: SceneBox, row: number): number => box.y + 52 + row * 38 + 17

/** Push each stub down until it clears the one above it. */
const stack = <A extends { readonly y: number; readonly h: number }>(
  items: ReadonlyArray<A>,
  gap: number
): ReadonlyArray<A> => {
  const sorted = [...items].sort((left, right) => left.y - right.y)
  const placed: Array<A> = []
  for (const item of sorted) {
    const previous = placed.at(-1)
    placed.push(
      previous === undefined || item.y >= previous.y + previous.h + gap
        ? item
        : { ...item, y: previous.y + previous.h + gap }
    )
  }
  return placed
}

export const layoutCluster = (
  graph: CanvasGraph,
  files: ReadonlyArray<CanvasFileView>,
  target: ClusterTarget
): ClusterScene => {
  const members = clusterMembers(files, target)
  const inside = new Set(members.map((file) => file.path))
  const columns = canvasModules(members)
  const boxes: Array<SceneBox> = []
  columns.forEach((column, index) => {
    let y = 88
    for (const file of column.files) {
      const parts = orderedParts(file.parts ?? [])
      const h = canvasBoxHeight(parts.length)
      boxes.push({ path: file.path, parts, x: 24 + index * (BOX_W + BOX_GAP), y, w: BOX_W, h })
      y += h + 32
    }
  })
  const byPath = new Map(boxes.map((box) => [box.path, box]))
  const right = Math.max(...boxes.map((box) => box.x + box.w), 24)
  const bottom = Math.max(...boxes.map((box) => box.y + box.h), 88)
  const edges = edgesOf(graph)
  const lines: Array<ScenePoint> = []
  for (const edge of edges) {
    const from = byPath.get(edge.from)
    const to = byPath.get(edge.to)
    if (from === undefined || to === undefined) continue
    const anchor = (box: SceneBox, other: SceneBox, part: string | null, top: boolean): readonly [number, number] => {
      const row = partRow(box, part)
      if (box.x === other.x) return [box.x + box.w / 2, top ? box.y : box.y + box.h]
      return [other.x > box.x ? box.x + box.w : box.x, row < 0 ? box.y + 26 : rowCenter(box, row)]
    }
    const [x1, y1] = anchor(from, to, edge.fromPart, from.y > to.y)
    const [x2, y2] = anchor(to, from, edge.toPart, to.y > from.y)
    lines.push({
      x1,
      y1,
      x2,
      y2,
      dash: edge.relation === "moved_from",
      faint: false,
      label: relationWords[edge.relation]
    })
  }
  const partitionOf = new Map(files.map((file) => [file.path, file.partition]))
  const stubSeeds = edges.flatMap((edge) => {
    const fromInside = inside.has(edge.from)
    if (fromInside === inside.has(edge.to)) return []
    const outside = fromInside ? edge.to : edge.from
    const box = byPath.get(fromInside ? edge.from : edge.to)
    if (box === undefined) return []
    const row = partRow(box, fromInside ? edge.fromPart : edge.toPart)
    const anchorY = row < 0 ? box.y + 26 : rowCenter(box, row)
    const partition = partitionOf.get(outside) ?? null
    const file = files.find((entry) => entry.path === outside)
    return [{
      path: outside,
      label: partition === null || target.kind !== "partition"
        ? outside
        : `${canvasBaseName(outside)}, in ${partition}`,
      line: stubLine(edge, outside, file),
      failing: failingTests(file),
      x: right + 36,
      y: anchorY - STUB_H / 2,
      w: STUB_W,
      h: STUB_H,
      anchor: { x: box.x + box.w, y: anchorY },
      incoming: !fromInside
    }]
  })
  const unique = stubSeeds.filter((stub, index) => stubSeeds.findIndex((other) => other.path === stub.path) === index)
  const stubs = stack(unique, 12)
  for (const stub of stubs) {
    lines.push(
      stub.incoming
        ? {
          x1: stub.x,
          y1: stub.y + STUB_H / 2,
          x2: stub.anchor.x,
          y2: stub.anchor.y,
          dash: true,
          faint: true,
          label: null
        }
        : {
          x1: stub.anchor.x,
          y1: stub.anchor.y,
          x2: stub.x,
          y2: stub.y + STUB_H / 2,
          dash: true,
          faint: true,
          label: null
        }
    )
  }
  const partition = target.kind === "partition" && graph.partitions._tag === "Recorded"
    ? graph.partitions.items.find((item) => item.id === target.id)
    : undefined
  const bandBottom = bottom + 28
  return {
    width: Math.max(CANVAS_WIDTH, right + 36 + STUB_W + 12),
    // The stubs share the minimap's column, so the canvas reaches past the lowest stub by a gap and the minimap.
    height: Math.max(
      CANVAS_MIN_HEIGHT,
      bandBottom + 40,
      ...stubs.map((stub) => stub.y + stub.h + 12 + CANVAS_MINIMAP.h + CANVAS_MINIMAP.inset)
    ),
    target,
    band: partition === undefined
      ? null
      : {
        id: partition.id,
        title: partition.title,
        files: partition.files.length,
        x: 12,
        y: 60,
        w: right + 20 - 12,
        h: bandBottom - 60,
        tab: { x: 12, y: -11 }
      },
    boxes,
    stubs: stubs.map(({ anchor: _anchor, incoming: _incoming, ...stub }) => stub),
    lines
  }
}

export interface FileRow {
  readonly part: CanvasPart
  /** The part's own findings, most severe first. */
  readonly findings: ReadonlyArray<CanvasFinding>
  readonly y: number
}

export interface FileScene {
  readonly width: number
  readonly height: number
  readonly path: string
  readonly box: Rect
  readonly rows: ReadonlyArray<FileRow>
  /** The most severe pinned finding opens as a card under its part. */
  readonly card: { readonly row: number; readonly finding: string } | null
  readonly callers: ReadonlyArray<SceneStub>
  readonly callees: ReadonlyArray<SceneStub>
  readonly lines: ReadonlyArray<ScenePoint>
}

const FILE_BOX = { x: 230, y: 72, w: 520 }
const FILE_HEADER = 48
const FILE_ROW = 44
const FILE_CARD = 128
/** The box is border-box with a 2px border, top and bottom. */
const FILE_BORDER = 4

const findingsOf = (
  findings: ReadonlyArray<CanvasFinding>,
  path: string,
  part: CanvasPart
): ReadonlyArray<CanvasFinding> =>
  findings
    .filter((finding) =>
      finding.path === path && finding.line !== null && part.lines !== null &&
      finding.line >= part.lines.start && finding.line <= part.lines.end
    )
    .sort((left, right) => reviewSeverityOrder.indexOf(left.severity) - reviewSeverityOrder.indexOf(right.severity))

/** The neighbours that meet a file: callers point into it, callees are what it uses. */
const neighbourStubs = (
  graph: CanvasGraph,
  files: ReadonlyArray<CanvasFileView>,
  path: string,
  direction: "callers" | "callees"
) => {
  const partitionOf = new Map(files.map((file) => [file.path, file.partition]))
  const self = partitionOf.get(path) ?? null
  const seen = new Set<string>()
  return edgesOf(graph).flatMap((edge) => {
    const other = direction === "callers"
      ? (edge.to === path ? edge.from : null)
      : (edge.from === path ? edge.to : null)
    if (other === null || seen.has(other)) return []
    seen.add(other)
    const file = files.find((entry) => entry.path === other)
    const partition = partitionOf.get(other) ?? null
    return [{
      edge,
      path: other,
      label: partition !== null && partition !== self
        ? `${canvasBaseName(other)}, in ${partition}`
        : canvasBaseName(other),
      line: stubLine(edge, other, file),
      failing: failingTests(file),
      part: direction === "callers" ? edge.toPart : edge.fromPart
    }]
  })
}

export const layoutFile = (
  graph: CanvasGraph,
  files: ReadonlyArray<CanvasFileView>,
  findings: ReadonlyArray<CanvasFinding>,
  path: string
): FileScene => {
  const file = files.find((entry) => entry.path === path)
  const parts = orderedParts(file?.parts ?? [])
  const pinned = parts
    .flatMap((part, row) => findingsOf(findings, path, part).slice(0, 1).map((finding) => ({ row, finding })))
    .sort((left, right) =>
      reviewSeverityOrder.indexOf(left.finding.severity) - reviewSeverityOrder.indexOf(right.finding.severity) ||
      left.row - right.row
    )[0]
  const rowTop = (row: number) =>
    FILE_BOX.y + FILE_HEADER + row * FILE_ROW + (pinned !== undefined && row > pinned.row ? FILE_CARD : 0)
  const rows = parts.map((part, row) => ({ part, findings: findingsOf(findings, path, part), y: rowTop(row) }))
  const height = FILE_HEADER + parts.length * FILE_ROW + (pinned === undefined ? 0 : FILE_CARD) + 6 + FILE_BORDER
  const box = { ...FILE_BOX, h: height }
  const centerOfPart = (name: string | null) => {
    const row = parts.findIndex((part) => part.name === name)
    return rowTop(row < 0 ? 0 : row) + FILE_ROW / 2
  }
  const place = (side: "callers" | "callees") =>
    stack(
      neighbourStubs(graph, files, path, side).map((stub) => ({
        ...stub,
        x: side === "callers" ? 24 : 784,
        y: centerOfPart(stub.part) - 30,
        w: side === "callers" ? 180 : 210,
        h: 48,
        target: centerOfPart(stub.part)
      })),
      16
    )
  const callers = place("callers")
  const callees = place("callees")
  const lines = [
    ...callers.map((stub) => ({
      x1: stub.x + stub.w,
      y1: stub.y + 24,
      x2: box.x,
      y2: stub.target,
      dash: true,
      faint: true,
      label: null
    })),
    ...callees.map((stub) => ({
      x1: box.x + box.w,
      y1: stub.target,
      x2: stub.x,
      y2: stub.y + 24,
      dash: true,
      faint: true,
      label: null
    }))
  ]
  const strip = ({ edge: _edge, part: _part, target: _target, ...stub }: (typeof callers)[number]): SceneStub => stub
  return {
    width: CANVAS_WIDTH,
    height: Math.max(
      CANVAS_MIN_HEIGHT,
      box.y + box.h + 40,
      ...[...callers, ...callees].map((stub) => stub.y + stub.h + 40)
    ),
    path,
    box,
    rows,
    card: pinned === undefined ? null : { row: pinned.row, finding: pinned.finding.id },
    callers: callers.map(strip),
    callees: callees.map(strip),
    lines
  }
}

export interface DiffScene {
  readonly width: number
  readonly height: number
  readonly path: string
  readonly part: CanvasPart
  readonly box: Rect
  readonly lines: { readonly start: number; readonly end: number }
  /** A finding card follows the line it is anchored to. */
  readonly cards: ReadonlyArray<{ readonly after: number; readonly finding: string }>
  readonly left: ReadonlyArray<SceneStub>
  readonly right: ReadonlyArray<SceneStub>
  /** The next part of the same file, below the frame. */
  readonly next: string | null
  readonly bottom: SceneStub | null
  readonly links: ReadonlyArray<ScenePoint>
}

const DIFF_BOX = { x: 120, y: 64, w: 700 }
const DIFF_HEADER = 52
const DIFF_LINE = 24
const DIFF_CARD = 196

export const layoutDiff = (
  graph: CanvasGraph,
  files: ReadonlyArray<CanvasFileView>,
  findings: ReadonlyArray<CanvasFinding>,
  path: string,
  partName: string
): DiffScene => {
  const file = files.find((entry) => entry.path === path)
  const parts = orderedParts(file?.parts ?? [])
  const index = parts.findIndex((part) => part.name === partName)
  const part = parts[index] ?? parts[0] ?? {
    name: partName,
    kind: "modified",
    movedPath: null,
    lines: null,
    added: 0,
    removed: 0
  }
  const lines = part.lines ?? { start: 1, end: 1 }
  const cards = findingsOf(findings, path, part).map((finding) => ({
    after: finding.line ?? lines.start,
    finding: finding.id
  }))
  const h = DIFF_HEADER + (lines.end - lines.start + 1) * DIFF_LINE + cards.length * DIFF_CARD
  const box = { ...DIFF_BOX, h }
  const side = (direction: "callers" | "callees", x: number) =>
    neighbourStubs(graph, files, path, direction).map((stub, row): SceneStub & { readonly target: number } => ({
      path: stub.path,
      label: stub.label,
      line: stub.line,
      failing: stub.failing,
      x,
      y: 180 + row * 120,
      w: 150,
      h: 48,
      target: box.y + DIFF_HEADER + row * 188
    }))
  const left = side("callers", DIFF_BOX.x - 176)
  const right = side("callees", DIFF_BOX.x + DIFF_BOX.w + 110)
  const nextPart = parts[index + 1] ?? null
  const bottom = nextPart === null
    ? null
    : {
      path,
      label: nextPart.name,
      line: `next in ${canvasBaseName(path)}`,
      failing: false,
      x: DIFF_BOX.x + DIFF_BOX.w / 2 - 90,
      y: box.y + box.h + 44,
      w: 180,
      h: 48
    }
  const links: Array<ScenePoint> = [
    ...left.map((stub) => ({
      x1: stub.x + stub.w,
      y1: stub.y + 24,
      x2: box.x,
      y2: stub.target,
      dash: true,
      faint: true,
      label: null
    })),
    ...right.map((stub) => ({
      x1: box.x + box.w,
      y1: stub.target,
      x2: stub.x,
      y2: stub.y + 24,
      dash: true,
      faint: true,
      label: null
    })),
    ...(bottom === null
      ? []
      : [{
        x1: bottom.x + bottom.w / 2,
        y1: box.y + box.h,
        x2: bottom.x + bottom.w / 2,
        y2: bottom.y,
        dash: true,
        faint: true,
        label: null
      }])
  ]
  const strip = ({ target: _target, ...stub }: SceneStub & { readonly target: number }): SceneStub => stub
  return {
    width: CANVAS_WIDTH,
    height: Math.max(CANVAS_MIN_HEIGHT, (bottom?.y ?? box.y + box.h) + 60),
    path,
    part,
    box,
    lines,
    cards,
    left: left.map(strip),
    right: right.map(strip),
    next: nextPart?.name ?? null,
    bottom,
    links
  }
}
