/**
 * The review canvas, drawn with Rly. A controlled view: the host owns readings, navigation and the view state, and
 * receives every canvas command. Import `@knpkv/review/canvas/styles.css` and the application's Rly stylesheet.
 * @module
 */
import { Button, Notice, Skeleton, StateLabel } from "@knpkv/rly/primitives"
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import {
  arrowLabels,
  changedSinceWords,
  changeLine,
  checkWords,
  findingLifeWords,
  focusDescription,
  levelLine,
  levelNames,
  noDependencyNotice,
  phoneChangeLine,
  phoneSinceLine,
  reviewLine,
  riskWords,
  sinceLine,
  sizeWords,
  statusLine,
  timeOfDay
} from "./copy.js"
import { CommitLabel } from "../commit-label.js"
import { canvasBaseName, type CanvasFileView, type CanvasFinding, type CanvasRisk } from "./derive.js"
import { CanvasGlyph, type CanvasGlyphName } from "./glyph.js"
import {
  type ClusterScene,
  clusterOf,
  type DiffScene,
  type FileScene,
  layoutCluster,
  layoutDiff,
  layoutFile,
  type OverviewScene,
  type Rect,
  type SceneStub
} from "./layout.js"
import type { CanvasFindingNote, CanvasPart, CanvasReading } from "./model.js"
import {
  canvasKeyCommand,
  type CanvasCommand,
  type CanvasLevel,
  canvasLevels,
  type CanvasViewState,
  type CanvasWorld,
  canvasWorldOf
} from "./view-state.js"

export interface ReviewCanvasPullRequest {
  readonly repository: string
  /** The provider's pull request number, without "#". */
  readonly number: string
  readonly title: string
  readonly sourceBranch: string
  readonly destinationBranch: string
}

/** The review run the findings came from; null when no run on this head was recorded. */
export interface ReviewCanvasReview {
  readonly reviewer: string
  readonly completedAt: number
}

/** Failed checks on the reviewed head. Unknown checks claim nothing. */
export type ReviewCanvasChecks =
  { readonly _tag: "Unknown" } | { readonly _tag: "Ready"; readonly failed: ReadonlyArray<string> }

export interface ReviewCanvasLine {
  readonly number: number
  readonly text: string
  readonly added: boolean
}

/** Head text of the file at Diff zoom. The host reads it on demand. */
export type ReviewCanvasText =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Unavailable"; readonly message: string }
  | {
      readonly _tag: "Ready"
      readonly readAt: number
      readonly headCommit: string
      readonly lines: ReadonlyArray<ReviewCanvasLine>
    }

export interface ReviewCanvasProps {
  readonly pullRequest: ReviewCanvasPullRequest
  readonly reading: CanvasReading
  readonly findings: ReadonlyArray<CanvasFinding>
  readonly review: ReviewCanvasReview | null
  readonly checks: ReviewCanvasChecks
  readonly state: CanvasViewState
  readonly onCommand: (command: CanvasCommand) => void
  /** Head text for the focused file at Diff zoom. */
  readonly text: ReviewCanvasText
  readonly hrefs: {
    readonly code: string
    readonly pullRequests: string
    /** The read-only diff of one file, for the Files list while the map builds. */
    readonly file: (path: string) => string
  }
  /** Findings this viewer marked handled. A reading mark only: nothing is posted. */
  readonly handled: ReadonlySet<string>
  readonly onToggleHandled: (finding: string) => void
  /** Formatting zone for times; the viewer's own zone when absent. */
  readonly timeZone?: string
}

const phoneQuery = "(max-width: 599px)"
const subscribeNarrow = (notify: () => void) => {
  const query = matchMedia(phoneQuery)
  query.addEventListener("change", notify)
  return () => query.removeEventListener("change", notify)
}
const useNarrow = (): boolean =>
  useSyncExternalStore(
    subscribeNarrow,
    () => matchMedia(phoneQuery).matches,
    () => false
  )

const TEXT2 = "var(--rly-color-text-2)"
const BLOCKED = "var(--rly-color-blocked-ink)"
const riskBorder = {
  high: "2px solid var(--rly-color-text-1)",
  medium: "1px solid var(--rly-color-border-2)",
  low: "1px dashed var(--rly-color-border-2)"
} satisfies Record<CanvasRisk, string>
const ink = { normal: "var(--rly-color-text-3)", strong: "var(--rly-color-text-1)", faint: "var(--rly-color-border-2)" }

const pos = (rect: {
  readonly x: number
  readonly y: number
  readonly w?: number
  readonly h?: number
}): CSSProperties => {
  const style: CSSProperties = { insetInlineStart: rect.x, insetBlockStart: rect.y }
  if (rect.w !== undefined) style.inlineSize = rect.w
  if (rect.h !== undefined) style.blockSize = rect.h
  return style
}

const Badge = ({ children }: { readonly children: string }): ReactElement => <b className="rc-pb">{children}</b>
const Kbd = ({ children }: { readonly children: string }): ReactElement => <kbd className="rc-kbd">{children}</kbd>

const Mark = ({
  children,
  color,
  glyph
}: {
  readonly glyph: CanvasGlyphName
  readonly color: string
  readonly children: string
}) => (
  <span className="rc-mk" style={{ color }}>
    <CanvasGlyph name={glyph} />
    <span>{children}</span>
  </span>
)

const markOf = (mark: CanvasFileView["marks"][number], changed: string) =>
  mark === "failing" ? (
    <Mark key="failing" glyph="alert" color={BLOCKED}>
      Failing
    </Mark>
  ) : (
    <Mark key="changed" glyph="clock" color={TEXT2}>
      {changed}
    </Mark>
  )

const round1 = (value: number): number => Math.round(value * 10) / 10

interface Line {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly dash: boolean
  readonly strong?: boolean
  readonly ink?: keyof typeof ink
}

/** Straight edges with arrowheads at the callee. */
const Edges = ({
  height,
  lines,
  width
}: {
  readonly lines: ReadonlyArray<Line>
  readonly width: number
  readonly height: number
}) => (
  <svg className="rc-edges" width={width} height={height} aria-hidden="true">
    {lines.map((line, index) => {
      const length = Math.hypot(line.x2 - line.x1, line.y2 - line.y1) || 1
      const ux = (line.x2 - line.x1) / length
      const uy = (line.y2 - line.y1) / length
      const ex = line.x2 - ux * 2
      const ey = line.y2 - uy * 2
      const head = line.strong === true ? 9 : 7
      const half = line.strong === true ? 4.5 : 3.5
      const color = ink[line.ink ?? "normal"]
      return (
        <g key={index}>
          <line
            x1={round1(line.x1)}
            y1={round1(line.y1)}
            x2={round1(ex - ux * (head - 1))}
            y2={round1(ey - uy * (head - 1))}
            style={{
              stroke: color,
              strokeWidth: line.strong === true ? 2 : 1.25,
              strokeDasharray: line.dash ? "5 4" : "none"
            }}
          />
          <polygon
            points={`${round1(ex)},${round1(ey)} ${round1(ex - ux * head - uy * half)},${round1(
              ey - uy * head + ux * half
            )} ${round1(ex - ux * head + uy * half)},${round1(ey - uy * head - ux * half)}`}
            style={{ fill: color }}
          />
        </g>
      )
    })}
  </svg>
)

const keyRows: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
  [["←", "↑", "→", "↓"], "Move along an edge to the next node"],
  [["Enter", "+"], "Zoom in on the focused node"],
  [["Esc", "−"], "Zoom out one level"],
  [["f"], "Fit the whole change"],
  [["/"], "Search files and functions"],
  [["l"], "Open the linear file list"]
]

interface Minimap {
  readonly rects: ReadonlyArray<Rect>
  readonly files: boolean
  readonly bands: boolean
  readonly viewport: Rect | null
}

const MinimapSvg = ({
  map,
  overview,
  selected
}: {
  readonly map: Minimap
  readonly overview: OverviewScene
  readonly selected?: string
}) => (
  <svg viewBox={`0 0 ${overview.width} ${overview.height}`} aria-hidden="true">
    {map.rects.map((rect, index) => (
      <rect
        key={`r${index}`}
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        rx="18"
        style={{ fill: "var(--rly-color-surface-3)" }}
      />
    ))}
    {map.bands
      ? overview.bands.map((band) => (
          <rect
            key={`b${band.id}`}
            x={band.x}
            y={band.y}
            width={band.w}
            height={band.h}
            rx="12"
            style={{ fill: "none", stroke: "var(--rly-color-text-2)", strokeWidth: 4, strokeDasharray: "14 10" }}
          />
        ))
      : null}
    {map.files
      ? overview.nodes.map((node) => (
          <rect
            key={`n${node.path}`}
            x={node.x}
            y={node.y}
            width={node.w}
            height="46"
            rx="6"
            style={{
              fill: node.path === selected ? "var(--rly-color-text-1)" : "var(--rly-color-surface-1)",
              stroke: "var(--rly-color-border-2)",
              strokeWidth: node.path === selected ? 0 : 3
            }}
          />
        ))
      : null}
    {selected === undefined && map.viewport !== null ? (
      <rect
        x={map.viewport.x}
        y={map.viewport.y}
        width={map.viewport.w}
        height={map.viewport.h}
        rx="6"
        style={{ fill: "none", stroke: "var(--rly-color-text-1)", strokeWidth: 8 }}
      />
    ) : null}
  </svg>
)

const sceneMinimap = (world: CanvasWorld, state: CanvasViewState): Minimap => {
  const overview = world.overview
  const full = { x: 0, y: 0, w: overview.width, h: overview.height }
  const modulesOnly = overview.mode === "modules"
  const base = { rects: overview.regions, files: !modulesOnly, bands: !modulesOnly }
  const node = overview.nodes.find((entry) => entry.path === state.focus)
  switch (state.level) {
    case "overview":
      return { ...base, viewport: full }
    case "cluster": {
      const target = clusterOf(world.graph, world.files, state.focus)
      const area =
        target?.kind === "partition"
          ? overview.bands.find((band) => band.id === target.id)
          : overview.regions.find((region) => region.id === target?.id)
      return { ...base, viewport: area ?? full }
    }
    case "file":
      return {
        ...base,
        viewport: node === undefined ? full : { x: node.x - 16, y: node.y - 12, w: node.w + 32, h: node.h + 22 }
      }
    case "diff":
      return { ...base, viewport: node === undefined ? full : { x: node.x, y: node.y, w: 60, h: 40 } }
  }
}

const miniLabel = (world: CanvasWorld, state: CanvasViewState): string => {
  switch (state.level) {
    case "overview":
      return state.keyboard
        ? `Map: the whole change is in view, focus on ${canvasBaseName(state.focus)}`
        : "Map: the whole change is in view"
    case "cluster": {
      const target = clusterOf(world.graph, world.files, state.focus)
      return `Map: ${target?.kind === "partition" ? `partition ${target.id}` : `module ${target?.id ?? ""}`} is in view`
    }
    case "file":
      return `Map: ${canvasBaseName(state.focus)} is in view`
    case "diff":
      return `Map: ${state.part ?? ""} in ${canvasBaseName(state.focus)} is in view`
  }
}

const canvasLabel = (world: CanvasWorld, state: CanvasViewState, number: string): string => {
  const head = `PR #${number} canvas`
  if (!world.ready) return `${head}, building`
  switch (state.level) {
    case "overview":
      return world.overview.mode === "modules"
        ? `${head}, Overview, by module only`
        : state.keyboard
          ? `${head}, Overview, focus on ${canvasBaseName(state.focus)}`
          : `${head}, Overview`
    case "cluster": {
      const target = clusterOf(world.graph, world.files, state.focus)
      return `${head}, Cluster, ${target?.kind === "partition" ? `partition ${target.id}` : `module ${target?.id ?? ""}`}`
    }
    case "file":
      return `${head}, File, ${canvasBaseName(state.focus)}`
    case "diff":
      return `${head}, Diff, ${state.part ?? ""}`
  }
}

const nodeLabel = (file: CanvasFileView): string =>
  [
    file.name,
    file.module,
    file.partition === null ? "" : `partition ${file.partition}`,
    sizeWords(file),
    riskWords[file.risk].toLowerCase(),
    ...file.badges,
    file.marks.includes("failing") ? "failing test" : "",
    file.marks.includes("changed") ? "changed since you looked" : ""
  ]
    .filter((part) => part !== "")
    .join(", ")

interface Shared {
  readonly props: ReviewCanvasProps
  readonly world: CanvasWorld
  readonly notes: Readonly<Record<string, CanvasFindingNote>>
  readonly changed: string | null
}

const OverviewParts = ({ scene, shared }: { readonly shared: Shared; readonly scene: OverviewScene }): ReactNode => {
  const { props, world } = shared
  const state = props.state
  const files = new Map(world.files.map((file) => [file.path, file]))
  const focus = state.keyboard ? state.focus : null
  const labels = state.keyboard ? arrowLabels(world, state) : new Map<string, string>()
  const rects = new Map(scene.nodes.map((node) => [node.path, node]))
  const lines = scene.lines.map((line) => ({
    ...line,
    strong: focus !== null && (line.from === focus || line.to === focus)
  }))
  return (
    <>
      {scene.regions.map((region) => (
        <div key={region.id} className="rc-region" aria-hidden="true" style={pos(region)}>
          <span>
            <b>{region.id}</b>
            <span>{region.files} files</span>
          </span>
        </div>
      ))}
      {lines.length > 0 ? <Edges lines={lines} width={scene.width} height={scene.height} /> : null}
      {scene.bands.map((band) => (
        <div key={band.id} className="rc-band" style={pos(band)}>
          <span style={{ left: band.tab.x, top: band.tab.y }}>
            <b>{band.id}</b>
            <span>
              {band.title}, {band.files} files
            </span>
          </span>
        </div>
      ))}
      {lines
        .filter((line) => line.strong)
        .map((line) => {
          const other = line.from === focus ? line.to : line.from
          const text = labels.get(other)
          const a = rects.get(line.from)
          const b = rects.get(line.to)
          if (text === undefined || a === undefined || b === undefined) return null
          const short = Math.hypot(line.x2 - line.x1, line.y2 - line.y1) < 120
          return (
            <span
              key={`label-${other}`}
              className="rc-elabel"
              aria-hidden="true"
              style={{
                left: Math.round((line.x1 + line.x2) / 2),
                top: Math.round(short ? Math.min(a.y, b.y) - 10 : (line.y1 + line.y2) / 2)
              }}
            >
              {text}
            </span>
          )
        })}
      {scene.nodes.map((node) => {
        const file = files.get(node.path)
        if (file === undefined) return null
        return (
          <button
            key={node.path}
            type="button"
            className="rc-nd"
            data-canvas-node={node.path}
            tabIndex={node.path === state.focus ? 0 : -1}
            aria-label={nodeLabel(file)}
            aria-current={node.path === state.focus ? "true" : undefined}
            style={{
              ...pos(node),
              border: riskBorder[file.risk],
              outline: node.path === focus ? "2px solid var(--rly-color-focus)" : "none"
            }}
            onClick={() => props.onCommand({ _tag: "Focus", path: node.path })}
            onDoubleClick={() => props.onCommand({ _tag: "ZoomIn" })}
          >
            <span className="rc-nm">{file.name}</span>
            <span className="rc-muted rc-tabular">{sizeWords(file)}</span>
            {file.marks.map((mark) => markOf(mark, "Changed"))}
            {file.badges.length > 0 ? (
              <span className="rc-badges">
                {file.badges.map((badge, index) => (
                  <Badge key={index}>{badge}</Badge>
                ))}
              </span>
            ) : null}
          </button>
        )
      })}
    </>
  )
}

const Legend = ({ scene, shared }: { readonly shared: Shared; readonly scene: OverviewScene }) => {
  const reviewer = shared.props.review?.reviewer ?? null
  const moved = scene.lines.some((line) => line.dash)
  return (
    <div className="rc-legend" role="region" aria-label="Legend" data-canvas-part="legend">
      <b>Legend</b>
      <span>
        <span className="rc-sw" style={{ border: riskBorder.high }} />
        High risk
        <span className="rc-sw" style={{ border: riskBorder.medium }} />
        Medium
        <span className="rc-sw" style={{ border: riskBorder.low }} />
        Low
      </span>
      <span className="rc-muted">Box size: changed lines</span>
      {scene.mode === "modules" ? (
        <span>
          <CanvasGlyph name="minus" />
          No edges or partitions: dependency data missing
        </span>
      ) : (
        <>
          <span>
            <span className="rc-ln22" style={{ borderBlockStart: "1.5px solid var(--rly-color-text-2)" }} />
            Call or import this change touches, to the callee
          </span>
          {moved ? (
            <span>
              <span className="rc-ln22" style={{ borderBlockStart: "1.5px dashed var(--rly-color-text-2)" }} />
              Moved from
            </span>
          ) : null}
          {scene.mode === "partitions" ? (
            <span>
              <span
                className="rc-ln22"
                style={{ blockSize: 10, border: "1.5px dashed var(--rly-color-text-2)", borderRadius: 4 }}
              />
              Partition: edits sharing a def-use chain
            </span>
          ) : null}
        </>
      )}
      {reviewer === null && shared.changed === null ? null : (
        <span>
          {reviewer === null ? null : (
            <>
              <Badge>P1</Badge>
              {reviewer} finding
            </>
          )}
          {shared.changed === null ? null : (
            <>
              <CanvasGlyph name="clock" />
              {shared.changed}
            </>
          )}
        </span>
      )}
    </div>
  )
}

const Stub = ({ align, stub }: { readonly stub: SceneStub; readonly align: "start" | "end" }) => (
  <div className="rc-stub" style={{ ...pos(stub), textAlign: align }}>
    <b>{stub.label}</b>
    <span
      className="rc-mk"
      style={{ justifyContent: align === "end" ? "flex-end" : "flex-start", color: stub.failing ? BLOCKED : TEXT2 }}
    >
      {stub.failing ? <CanvasGlyph name="alert" /> : null}
      <span>{stub.line}</span>
    </span>
  </div>
)

const partKind = (part: CanvasPart, newFile: boolean): string => {
  if (newFile && (part.kind === "added" || part.kind === "moved_from")) return ""
  switch (part.kind) {
    case "added":
      return "Added"
    case "modified":
      return "Modified"
    case "removed":
      return "Removed"
    case "moved_to":
      return `Moved to ${canvasBaseName(part.movedPath ?? "")}`
    case "moved_from":
      return `Moved from ${canvasBaseName(part.movedPath ?? "")}`
  }
}

const partSize = (part: CanvasPart, newFile: boolean): string =>
  part.kind === "moved_to" || part.kind === "removed"
    ? `−${part.removed}`
    : newFile || part.kind === "added" || part.kind === "moved_from"
      ? `+${part.added}`
      : `±${part.added + part.removed}`

const findingsOfPart = (findings: ReadonlyArray<CanvasFinding>, path: string, part: CanvasPart) =>
  findings.filter(
    (finding) =>
      finding.path === path &&
      finding.line !== null &&
      part.lines !== null &&
      finding.line >= part.lines.start &&
      finding.line <= part.lines.end
  )

const LifeLabel = ({ note }: { readonly note: CanvasFindingNote | undefined }) => {
  const words = findingLifeWords(note)
  return words === null ? null : (
    <StateLabel label={words} size="compact" tone={note?.life._tag === "Fixed" ? "positive" : "caution"} />
  )
}

const ClusterParts = ({ scene, shared }: { readonly shared: Shared; readonly scene: ClusterScene }) => {
  const { notes, props, world } = shared
  const files = new Map(world.files.map((file) => [file.path, file]))
  return (
    <>
      {scene.band === null ? null : (
        <div className="rc-band" style={pos(scene.band)}>
          <span style={{ left: scene.band.tab.x, top: scene.band.tab.y }}>
            <b>{scene.band.id}</b>
            <span>
              {scene.band.title}, {scene.band.files} files
            </span>
          </span>
        </div>
      )}
      <Edges
        lines={scene.lines.map((line) => ({ ...line, ink: line.faint ? "faint" : "normal" }))}
        width={scene.width}
        height={scene.height}
      />
      {scene.lines.flatMap((line, index) =>
        line.label === null
          ? []
          : [
              <span
                key={`label-${index}`}
                className="rc-elabel"
                aria-hidden="true"
                style={{ left: Math.round((line.x1 + line.x2) / 2), top: Math.round((line.y1 + line.y2) / 2) }}
              >
                {line.label}
              </span>
            ]
      )}
      {scene.boxes.map((box) => {
        const file = files.get(box.path)
        if (file === undefined) return null
        const newFile = file.status === "added"
        return (
          <div
            key={box.path}
            className="rc-box"
            role="group"
            data-canvas-node={box.path}
            aria-label={`${box.path}, ${riskWords[file.risk].toLowerCase()}, ${box.parts.length} functions changed`}
            aria-current={box.path === props.state.focus ? "true" : undefined}
            style={{ ...pos(box), border: riskBorder[file.risk] }}
          >
            <div className="rc-hd">
              <b>{box.path}</b>
              <span>
                <span>
                  {newFile ? "New file, " : ""}
                  {sizeWords(file)}
                </span>
                <span>{riskWords[file.risk]}</span>
                {file.marks.includes("changed") ? (
                  <Mark glyph="clock" color={TEXT2}>
                    Changed
                  </Mark>
                ) : null}
              </span>
            </div>
            {box.parts.map((part) => {
              const finding = findingsOfPart(props.findings, box.path, part)[0]
              return (
                <div key={part.name} className="rc-fn">
                  <code>{part.name}</code>
                  <span className="rc-muted rc-nowrap">{partKind(part, newFile)}</span>
                  <span className="rc-ln">{partSize(part, newFile)}</span>
                  <span className="rc-mk">
                    {finding === undefined ? null : <Badge>{finding.severity}</Badge>}
                    {finding === undefined ? null : <LifeLabel note={notes[finding.id]} />}
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
      {scene.stubs.map((stub) => (
        <Stub key={stub.path} stub={stub} align="start" />
      ))}
    </>
  )
}

const evidenceWords = (note: CanvasFindingNote | undefined): string | null =>
  note?.evidence == null
    ? null
    : `Failing in ${note.evidence.check}: ${canvasBaseName(note.evidence.file)}, “${note.evidence.test}”`

const FileParts = ({ scene, shared }: { readonly shared: Shared; readonly scene: FileScene }) => {
  const { notes, props, world } = shared
  const file = world.files.find((entry) => entry.path === scene.path)
  if (file === undefined) return null
  const newFile = file.status === "added"
  const widest = Math.max(
    1,
    ...scene.rows.map((row) => row.part.added + (row.part.kind === "modified" ? row.part.removed : 0))
  )
  return (
    <>
      <Edges lines={scene.lines.map((line) => ({ ...line, ink: "faint" }))} width={scene.width} height={scene.height} />
      {scene.callers.map((stub) => (
        <Stub key={`c${stub.path}`} stub={stub} align="end" />
      ))}
      {scene.callees.map((stub) => (
        <Stub key={`e${stub.path}`} stub={stub} align="start" />
      ))}
      <div
        className="rc-fz"
        role="group"
        aria-label={`${scene.path}, ${riskWords[file.risk].toLowerCase()}, ${scene.rows.length} parts changed`}
        style={pos(scene.box)}
      >
        <div className="rc-hd">
          <b>{scene.path}</b>
          <span>
            {newFile ? "New file, " : ""}
            {sizeWords(file)}
          </span>
          <span>{riskWords[file.risk]}</span>
          {file.marks.includes("changed") ? (
            <span className="rc-mk">
              <CanvasGlyph name="clock" />
              Changed since you looked
            </span>
          ) : null}
        </div>
        {scene.rows.map((row, index) => {
          const finding = row.findings[0]
          const card =
            scene.card?.row === index ? props.findings.find((entry) => entry.id === scene.card?.finding) : undefined
          const moved = row.part.kind === "moved_from" || row.part.kind === "moved_to"
          const size = row.part.added + (row.part.kind === "modified" ? row.part.removed : 0)
          const evidence = card === undefined ? null : evidenceWords(notes[card.id])
          return (
            <div key={row.part.name}>
              <button
                type="button"
                className="rc-fzr"
                aria-current={props.state.part === row.part.name ? "true" : undefined}
                onClick={() => props.onCommand({ _tag: "FocusPart", part: row.part.name })}
                // Keyboard focus selects the row too, so Enter opens the row it is on.
                onFocus={() => props.onCommand({ _tag: "FocusPart", part: row.part.name })}
                onDoubleClick={() => {
                  props.onCommand({ _tag: "FocusPart", part: row.part.name })
                  props.onCommand({ _tag: "ZoomIn" })
                }}
              >
                <code>{row.part.name}</code>
                <span className="rc-k">
                  {partKind(row.part, false)}
                  {row.part.lines === null ? "" : `, lines ${row.part.lines.start}–${row.part.lines.end}`}
                </span>
                <span className="rc-bar" aria-hidden="true">
                  <span
                    style={{
                      inlineSize: `${Math.round((size / widest) * 100)}%`,
                      background: moved ? "transparent" : TEXT2,
                      border: moved ? "1.5px dashed var(--rly-color-text-2)" : "0"
                    }}
                  />
                </span>
                <span className="rc-mono" style={{ textAlign: "end" }}>
                  {partSize(row.part, true)}
                </span>
                <span className="rc-mk" style={{ justifyContent: "end" }}>
                  {finding === undefined ? null : <Badge>{finding.severity}</Badge>}
                  {finding === undefined ? null : <LifeLabel note={notes[finding.id]} />}
                </span>
              </button>
              {card === undefined ? null : (
                <div className="rc-fzf" role="note" aria-label={`Finding ${card.id}, pinned to ${row.part.name}`}>
                  <span className="rc-mk rc-small">
                    <CanvasGlyph name="arrow" />
                    Pinned to {row.part.name}, between lines {card.line} and {(card.line ?? 0) + 1}
                  </span>
                  <span className="rc-t">{card.title}</span>
                  {evidence === null ? null : <span className="rc-small">{evidence}</span>}
                  <span className="rc-mk rc-small">
                    <span>Enter opens the lines</span>
                    <Kbd>Enter</Kbd>
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

const hunkHeader = (scene: DiffScene, newFile: boolean, first: string | undefined): string => {
  const count = scene.lines.end - scene.lines.start + 1
  const context = (first ?? "").trim().split(/[({]/u)[0]?.trim() ?? ""
  return `@@ ${newFile ? "−0,0 " : ""}+${scene.lines.start},${count} @@${context === "" ? "" : ` ${context}`}`
}

/** "Raised 11:40 on “Title, 11:31”, still open at “Title, 14:18”", or nothing for a finding not still open. */
const Raised = ({
  copy,
  head,
  note,
  timeZone
}: {
  readonly copy: boolean
  readonly head: string
  readonly note: CanvasFindingNote | undefined
  readonly timeZone: string | undefined
}): ReactNode =>
  note?.life._tag === "StillOpen" ? (
    <span className="rc-small">
      Raised {timeOfDay(note.life.raisedAt, timeZone)} on <CommitLabel commit={note.life.raisedHead} copy={copy} />,
      still open at <CommitLabel commit={head} copy={copy} />
    </span>
  ) : null

const FindingCard = ({
  after,
  copy = true,
  finding,
  phone,
  shared
}: {
  readonly finding: CanvasFinding
  readonly shared: Shared
  readonly after: number
  readonly phone: boolean
  /** False inside the shrunk drawing, where a copy button cannot keep its 44px target. */
  readonly copy?: boolean
}) => {
  const { notes, props, world } = shared
  const note = notes[finding.id]
  const evidence = note?.evidence ?? null
  const handled = props.handled.has(finding.id)
  return (
    <div
      className="rc-fcard"
      role="note"
      aria-label={`Finding ${finding.id}, between lines ${after} and ${after + 1}`}
      data-canvas-part="finding"
    >
      <div className="rc-row">
        <Badge>{finding.severity}</Badge>
        <LifeLabel note={note} />
        {phone ? null : <Raised copy={copy} head={world.graph.headRevision} note={note} timeZone={props.timeZone} />}
      </div>
      <span className="rc-t">{finding.title}</span>
      {finding.body === "" ? null : <span className="rc-muted">{finding.body}</span>}
      {evidence === null ? null : (
        <span className="rc-mk" style={phone ? { flexWrap: "wrap" } : undefined}>
          <StateLabel label="Failed" size="compact" tone="critical" />
          <span>{evidenceWords(note)}</span>
        </span>
      )}
      {phone ? null : (
        <div className="rc-row" data-canvas-part="action">
          <Button size="default" aria-pressed={handled} onClick={() => props.onToggleHandled(finding.id)}>
            {handled ? "Handled" : "Mark handled"}
          </Button>
          <span className="rc-small" style={{ fontSize: ".8125rem" }}>
            Handled is your reading mark; nothing posts.
          </span>
        </div>
      )}
    </div>
  )
}

const diffRows = (scene: DiffScene, text: ReviewCanvasText) =>
  text._tag === "Ready"
    ? text.lines.filter((line) => line.number >= scene.lines.start && line.number <= scene.lines.end)
    : []

const DiffParts = ({
  scene,
  shared,
  shrunk
}: {
  readonly shared: Shared
  readonly scene: DiffScene
  readonly shrunk: boolean
}) => {
  const { props, world } = shared
  const file = world.files.find((entry) => entry.path === scene.path)
  const rows = diffRows(scene, props.text)
  const text = props.text
  return (
    <>
      <Edges lines={scene.links.map((line) => ({ ...line, ink: "faint" }))} width={scene.width} height={scene.height} />
      {scene.left.map((stub) => (
        <Stub key={`l${stub.path}`} stub={stub} align="end" />
      ))}
      {scene.right.map((stub) => (
        <Stub key={`r${stub.path}`} stub={stub} align="start" />
      ))}
      {scene.bottom === null ? null : <Stub stub={scene.bottom} align="start" />}
      <div
        className="rc-dz"
        role="group"
        aria-label={`Diff of ${scene.part.name} in ${scene.path}`}
        style={pos({ x: scene.box.x, y: scene.box.y, w: scene.box.w })}
      >
        <div className="rc-hd">
          <b>
            {scene.path}, {scene.part.name}
          </b>
          <code className="rc-small">{hunkHeader(scene, file?.status === "added", rows[0]?.text)}</code>
          {text._tag === "Ready" ? (
            <span className="rc-small" style={{ marginInlineStart: "auto" }}>
              Diff read {timeOfDay(text.readAt, props.timeZone)}, head{" "}
              <CommitLabel commit={text.headCommit} copy={!shrunk} />
            </span>
          ) : null}
        </div>
        {text._tag === "Loading" ? (
          <p className="rc-small rc-dz-note" role="status">
            Reading the lines…
          </p>
        ) : null}
        {text._tag === "Unavailable" ? <p className="rc-small rc-dz-note">{text.message}</p> : null}
        {rows.map((line) => {
          const cards = scene.cards.filter((card) => card.after === line.number)
          return (
            <div key={line.number}>
              <div
                className={line.added ? "rc-dl" : "rc-dl rc-dl-context"}
                aria-label={`${line.added ? "Added line" : "Line"} ${line.number}`}
              >
                <span className="rc-no">{line.number}</span>
                <span aria-hidden="true">{line.added ? "+" : ""}</span>
                <span className="rc-c">{line.text}</span>
              </div>
              {cards.flatMap((card) => {
                const finding = props.findings.find((entry) => entry.id === card.finding)
                return finding === undefined
                  ? []
                  : [
                      <FindingCard
                        key={card.finding}
                        copy={!shrunk}
                        finding={finding}
                        shared={shared}
                        after={card.after}
                        phone={false}
                      />
                    ]
              })}
            </div>
          )
        })}
      </div>
    </>
  )
}

const skeletons: ReadonlyArray<Rect> = [
  { x: 332, y: 64, w: 320, h: 300 },
  { x: 668, y: 64, w: 336, h: 300 },
  { x: 332, y: 380, w: 320, h: 200 },
  { x: 668, y: 380, w: 336, h: 200 }
]

const BuildingParts = ({ shared }: { readonly shared: Shared }) => (
  <>
    <div className="rc-bl" data-canvas-part="files">
      <b>
        Files,{" "}
        {shared.props.reading.graph._tag === "Building" ? shared.props.reading.graph.total : shared.world.files.length}
      </b>
      <span className="rc-small">The file list works now. The map opens when every file is placed.</span>
      <ul>
        {shared.world.files.map((file) => (
          <li key={file.path}>
            <a href={shared.props.hrefs.file(file.path)}>{file.path}</a>
            <span className="rc-badge-row">
              {file.badges.map((badge, index) => (
                <Badge key={index}>{badge}</Badge>
              ))}
            </span>
            <span className="rc-mono rc-muted">{sizeWords(file)}</span>
          </li>
        ))}
      </ul>
    </div>
    {skeletons.map((rect, index) => (
      <div key={index} style={pos(rect)}>
        <Skeleton variant="block" height={rect.h} />
      </div>
    ))}
  </>
)

/** Scale the fixed-width frame down to the column, never up. */
const useFit = (width: number, height: number) => {
  const scroll = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const element = scroll.current
    if (element === null) return
    const measure = () => setScale(Math.min(1, element.clientWidth / width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [width])
  return { scroll, scale, style: { blockSize: Math.ceil(height * scale) } }
}

const canvasControls = 'a[href], button, input, select, textarea, [contenteditable="true"]'

const CanvasFrame = ({ shared }: { readonly shared: Shared }) => {
  const { props, world } = shared
  const state = props.state
  const level = world.ready ? state.level : "overview"
  const cluster = level === "cluster" ? clusterOf(world.graph, world.files, state.focus) : null
  const scene = !world.ready
    ? { width: 1016, height: 640 }
    : level === "cluster" && cluster !== null
      ? layoutCluster(world.graph, world.files, cluster)
      : level === "file"
        ? layoutFile(world.graph, world.files, props.findings, state.focus)
        : level === "diff"
          ? layoutDiff(world.graph, world.files, props.findings, state.focus, state.part ?? "")
          : world.overview
  const fit = useFit(scene.width, scene.height)
  const frame = useRef<HTMLDivElement>(null)
  // While the keyboard drives the canvas, focus follows the focused file or part. A zoom can remove the focused
  // element, which drops focus to the body; the canvas then takes it back so the next key still reaches it.
  useEffect(() => {
    const root = frame.current
    const active = document.activeElement
    if (root === null || !state.keyboard) return
    if (active !== null && active !== document.body && !root.contains(active)) return
    const target =
      root.querySelector<HTMLElement>(`[data-canvas-node="${CSS.escape(state.focus)}"]`) ??
      root.querySelector<HTMLElement>('.rc-fzr[aria-current="true"]') ??
      root
    target.focus({ preventScroll: true })
  }, [state.focus, state.keyboard, state.part, level])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    // Keys on a control inside the canvas (Mark handled, a link) belong to that control. File nodes and part rows
    // are the canvas's own targets.
    // A key event's target is the focused element.
    const control = document.activeElement?.closest(canvasControls) ?? null
    if (control !== null && !control.matches("[data-canvas-node], .rc-fzr")) return
    const command = canvasKeyCommand(event.key)
    if (command === null) return
    event.preventDefault()
    if (!state.keyboard) props.onCommand({ _tag: "Keyboard", on: true })
    props.onCommand(command)
  }
  const mini = world.ready ? sceneMinimap(world, state) : null
  // The key panel takes the legend's place while the keyboard drives the overview.
  const showLegend = world.ready && level === "overview" && !state.keyboard
  return (
    <div className="rc-cvwrap">
      <div className="rc-canvas" data-canvas-frame="">
        <div className="rc-cvscroll" ref={fit.scroll} style={fit.style}>
          <div className="rc-cvfit" style={fit.scale < 1 ? { transform: `scale(${fit.scale})` } : undefined}>
            <div
              ref={frame}
              className="rc-cv"
              role="region"
              tabIndex={-1}
              aria-label={`${canvasLabel(world, state, props.pullRequest.number)}. A visual aid; the Files list (l) has the whole review`}
              style={{ blockSize: scene.height, inlineSize: scene.width }}
              onKeyDown={onKeyDown}
              onPointerDown={() => {
                if (state.keyboard) props.onCommand({ _tag: "Keyboard", on: false })
              }}
            >
              {!world.ready ? (
                <BuildingParts shared={shared} />
              ) : "boxes" in scene ? (
                <ClusterParts shared={shared} scene={scene} />
              ) : "rows" in scene ? (
                <FileParts shared={shared} scene={scene} />
              ) : "cards" in scene ? (
                <DiffParts shared={shared} scene={scene} shrunk={fit.scale < 1} />
              ) : (
                <OverviewParts shared={shared} scene={world.overview} />
              )}
              {state.keyboard && world.ready && level === "overview" ? (
                <div
                  className="rc-panel"
                  role="region"
                  aria-label="Keys on the canvas"
                  data-canvas-part="keys"
                  style={{ insetInlineEnd: 12, insetBlockStart: 12, inlineSize: 300 }}
                >
                  <b>Keys on the canvas</b>
                  {keyRows.map(([keys, what]) => (
                    <div key={what} className="rc-keyrow">
                      <span>
                        {keys.map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </span>
                      <span>{what}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {showLegend ? <Legend shared={shared} scene={world.overview} /> : null}
              {mini === null ? null : (
                <div className="rc-minimap" role="img" aria-label={miniLabel(world, state)} data-canvas-part="minimap">
                  <span>Map, {levelNames[level]}</span>
                  <MinimapSvg map={mini} overview={world.overview} />
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="rc-status" role="status">
          {world.ready ? null : <StateLabel label="Building" size="compact" tone="progress" />}
          <span>
            {state.keyboard && world.ready && level === "overview"
              ? focusDescription(world, state, notesOf(props))
              : statusLine(world, state, props.reading.graph._tag === "Building" ? props.reading.graph : null)}
          </span>
        </div>
      </div>
    </div>
  )
}

const notesOf = (props: ReviewCanvasProps) => props.reading.context.findings

const failedChecks = (checks: ReviewCanvasChecks): ReadonlyArray<string> =>
  checks._tag === "Ready" ? checks.failed : []

const Desktop = ({ shared }: { readonly shared: Shared }) => {
  const { props, world } = shared
  const pr = props.pullRequest
  const failed = failedChecks(props.checks)
  const since = sinceLine(props.reading.context.lastLook, props.timeZone)
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const command = (next: CanvasCommand) => {
    if (next._tag === "Search") search.current?.focus()
    else props.onCommand(next)
  }
  const canvasProps = { ...props, onCommand: command }
  const level = world.ready ? props.state.level : "overview"
  return (
    <div className="rc-page" data-review-canvas="">
      <div className="rc-prhead" data-review-canvas-header="">
        <nav className="rc-crumbs" aria-label="Breadcrumb">
          <a href={props.hrefs.code}>Code</a>
          <span aria-hidden="true">/</span>
          <a href={props.hrefs.pullRequests}>Pull requests</a>
          <span aria-hidden="true">/</span>
          <b aria-current="page">#{pr.number}</b>
        </nav>
        <span className="rc-repo">
          {pr.repository} #{pr.number}
        </span>
        <h1>{pr.title}</h1>
        <div className="rc-meta">
          <span>
            <code>{pr.sourceBranch}</code> into <code>{pr.destinationBranch}</code>
          </span>
          <span>{changeLine(world.files)}</span>
          {failed.length === 0 ? null : (
            <span>
              <StateLabel label={checkWords(failed)} size="compact" tone="critical" />
              <code>{failed.join(", ")}</code>
            </span>
          )}
          {props.review === null ? null : (
            <span>{reviewLine(props.review.reviewer, props.review.completedAt, props.findings, props.timeZone)}</span>
          )}
        </div>
      </div>
      <div className="rc-tabsrow" data-review-canvas-tabs="">
        <div role="group" aria-label="View" className="rc-seg2">
          <button
            type="button"
            aria-pressed={props.state.panel === "canvas"}
            onClick={() => props.state.panel === "files" && props.onCommand({ _tag: "TogglePanel" })}
          >
            Canvas
          </button>
          <button
            type="button"
            aria-pressed={props.state.panel === "files"}
            onClick={() => props.state.panel === "canvas" && props.onCommand({ _tag: "TogglePanel" })}
          >
            Files
            <Kbd>l</Kbd>
          </button>
        </div>
      </div>
      <div className="rc-toolbar" data-review-canvas-toolbar="">
        <div role="group" aria-label="Zoom level" className="rc-ladder">
          {canvasLevels.map((entry, index) => (
            <button
              key={entry}
              type="button"
              aria-current={entry === level ? "true" : "false"}
              aria-disabled={world.ready ? "false" : "true"}
              onClick={() => world.ready && props.onCommand({ _tag: "Level", level: entry })}
            >
              <span className="rc-n">{index + 1}</span>
              {levelNames[entry]}
            </button>
          ))}
        </div>
        <span className="rc-levelline">{levelLine(world, props.state)}</span>
        <label className="rc-search">
          <span className="rc-sr">Search files and functions</span>
          <input
            ref={search}
            type="search"
            placeholder="Search files and functions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              const match = world.files.find((file) => file.path.toLowerCase().includes(query.trim().toLowerCase()))
              if (match !== undefined && query.trim() !== "") props.onCommand({ _tag: "Focus", path: match.path })
            }}
          />
          <Kbd>/</Kbd>
        </label>
        {since === null ? null : (
          <span className="rc-sinceline">
            <CanvasGlyph name="clock" size={14} />
            <span>{since}</span>
          </span>
        )}
      </div>
      {world.ready && world.overview.mode === "modules" ? (
        <div className="rc-notice-wrap" data-review-canvas-notice="">
          <Notice icon="minus" tone="neutral">
            <span>{noDependencyNotice(world.graph, pr.repository)}</span>
          </Notice>
        </div>
      ) : null}
      {props.state.panel === "files" ? (
        <LinearList shared={shared} />
      ) : (
        <CanvasFrame shared={{ ...shared, props: canvasProps }} />
      )}
    </div>
  )
}

/** The Files list: every file in reading order with its changed parts. The canvas's linear equivalent. */
const LinearList = ({ shared }: { readonly shared: Shared }) => {
  const { props, world } = shared
  const files = new Map(world.files.map((file) => [file.path, file]))
  const groups = chapters(shared)
  return (
    <div className="rc-cvwrap">
      <section className="rc-linear" aria-label="Review in reading order">
        <div>
          <h2>Review in reading order</h2>
          <span className="rc-small">
            Screen readers get this list first; the canvas is a visual aid. l switches back and keeps your place.
          </span>
        </div>
        <ol style={{ display: "grid", gap: 18 }}>
          {groups.map((group) => (
            <li key={group.title} className="rc-chap">
              <h3>
                <span>{group.title}</span>
                <span>{group.meta}</span>
              </h3>
              <ol className="rc-lfiles">
                {group.files.map((path) => {
                  const file = files.get(path)
                  if (file === undefined) return null
                  return (
                    <li key={path} className="rc-lfile">
                      <div className="rc-hd">
                        <span className="rc-small rc-mono">{world.order.indexOf(path) + 1}</span>
                        <code>{path}</code>
                        <span className="rc-small">
                          {riskWords[file.risk]}, {sizeWords(file)}.
                        </span>
                      </div>
                      <ul>
                        {(file.parts ?? []).map((part) => (
                          <li
                            key={part.name}
                            className="rc-hunk"
                            aria-current={
                              path === props.state.focus && part.name === props.state.part ? "true" : "false"
                            }
                          >
                            <code>{part.name}</code>
                            <span className="rc-muted">
                              {partKind(part, file.status === "added") || "Added"},{" "}
                              {partSize(part, file.status === "added")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  )
                })}
              </ol>
            </li>
          ))}
        </ol>
      </section>
      <div className="rc-status" role="status">
        <span>{levelLine(world, props.state)}</span>
      </div>
    </div>
  )
}

interface Chapter {
  readonly title: string
  readonly heading: string
  readonly meta: string
  readonly files: ReadonlyArray<string>
}

/** Reading-path chapters when recorded; otherwise one chapter per module, in reading order. */
const chapters = (shared: Shared): ReadonlyArray<Chapter> => {
  const { props, world } = shared
  const files = new Map(world.files.map((file) => [file.path, file]))
  const path = props.reading.context.readingPath
  const severities = (paths: ReadonlyArray<string>) => paths.flatMap((entry) => files.get(entry)?.badges ?? [])
  if (path._tag === "Recorded") {
    return path.chapters.map((chapter, index) => {
      const found = severities(chapter.files)
      return {
        title: `${index + 1}. ${chapter.partition === null ? "" : `Partition ${chapter.partition}, `}${chapter.title}`,
        heading: `${index + 1}. ${chapter.partition === null ? "" : `${chapter.partition}, `}${chapter.title}`,
        meta: `${chapter.files.length} files${found.length === 0 ? "" : `, ${found.join(", ")}`}. ${chapter.why}.`,
        files: chapter.files
      }
    })
  }
  const modules = Array.from(new Set(world.order.map((entry) => files.get(entry)?.module ?? "")))
  return modules.map((module, index) => {
    const members = world.order.filter((entry) => files.get(entry)?.module === module)
    return {
      title: `${index + 1}. ${module}`,
      heading: module,
      meta: `${members.length} files.`,
      files: members
    }
  })
}

const PhoneRow = ({
  file,
  numbered,
  shared
}: {
  readonly shared: Shared
  readonly file: CanvasFileView
  readonly numbered: boolean
}) => {
  const { props, world } = shared
  const changed = shared.changed ?? "Changed"
  return (
    <li>
      <button
        type="button"
        className="rc-prow"
        aria-current={numbered ? (file.path === props.state.focus ? "true" : "false") : undefined}
        style={numbered ? undefined : { gridTemplateColumns: "minmax(0, 1fr) auto" }}
        onClick={() => {
          props.onCommand({ _tag: "Focus", path: file.path })
          props.onCommand({ _tag: "Level", level: "diff" })
        }}
      >
        {numbered ? <span className="rc-n">{world.order.indexOf(file.path) + 1}</span> : null}
        <span className="rc-b">
          <code>{file.name}</code>
          <span>
            {numbered
              ? `${file.module}, ${riskWords[file.risk].toLowerCase()}, ${sizeWords(file)}`
              : `${riskWords[file.risk]}, ${sizeWords(file)}`}
          </span>
          {file.marks.map((mark) => markOf(mark, numbered ? changed : "Changed"))}
        </span>
        <span className="rc-bd">
          {file.badges.map((badge, index) => (
            <Badge key={index}>{badge}</Badge>
          ))}
        </span>
      </button>
    </li>
  )
}

const PhoneDiff = ({ shared }: { readonly shared: Shared }) => {
  const { props, world } = shared
  const scene = layoutDiff(world.graph, world.files, props.findings, props.state.focus, props.state.part ?? "")
  const file = world.files.find((entry) => entry.path === scene.path)
  if (file === undefined) return null
  const rows = diffRows(scene, props.text)
  const stop = world.order.indexOf(file.path)
  const next = world.order[stop + 1]
  const text = props.text
  return (
    <>
      <button type="button" className="rc-pback" onClick={() => props.onCommand({ _tag: "Fit" })}>
        <span aria-hidden="true">←</span>
        <span>Reading order</span>
      </button>
      <div className="rc-pfile">
        <h1>{file.name}</h1>
        <code>{file.path}</code>
        <span>
          Stop {stop + 1} of {world.files.length}
          {file.partition === null ? "" : `, partition ${file.partition}`}. {riskWords[file.risk]}, {sizeWords(file)}.
        </span>
        {shared.changed !== null && file.marks.includes("changed") ? (
          <span className="rc-mk" style={{ color: "var(--rly-color-text-1)" }}>
            <CanvasGlyph name="clock" />
            <span>{shared.changed}</span>
          </span>
        ) : null}
      </div>
      <div className="rc-pdiff" data-canvas-part="files">
        <div className="rc-hd">
          <b>
            {scene.part.name}
            {scene.part.lines === null ? "" : `, lines ${scene.part.lines.start}–${scene.part.lines.end}`}
          </b>
          {text._tag === "Ready" ? (
            <span className="rc-small" style={{ fontSize: ".6875rem" }}>
              Diff read {timeOfDay(text.readAt, props.timeZone)}, head <CommitLabel commit={text.headCommit} />
            </span>
          ) : null}
        </div>
        {rows.map((line) => (
          <div key={line.number}>
            <div
              className={line.added ? "rc-pdl" : "rc-pdl rc-dl-context"}
              aria-label={`${line.added ? "Added line" : "Line"} ${line.number}`}
            >
              <span className="rc-no">{line.number}</span>
              <span aria-hidden="true">{line.added ? "+" : ""}</span>
              <span className="rc-c">{line.text}</span>
            </div>
            {scene.cards
              .filter((card) => card.after === line.number)
              .flatMap((card) => {
                const finding = props.findings.find((entry) => entry.id === card.finding)
                return finding === undefined
                  ? []
                  : [<FindingCard key={card.finding} finding={finding} shared={shared} after={card.after} phone />]
              })}
          </div>
        ))}
      </div>
      <div className="rc-pact" data-canvas-part="action">
        {scene.cards.slice(0, 1).map((card) => (
          <Button
            key={card.finding}
            size="default"
            stretch
            aria-pressed={props.handled.has(card.finding)}
            onClick={() => props.onToggleHandled(card.finding)}
          >
            {props.handled.has(card.finding) ? "Handled" : "Mark handled"}
          </Button>
        ))}
        {scene.cards.length === 0 ? null : (
          <span className="rc-small">Handled is your reading mark; nothing posts.</span>
        )}
        {next === undefined ? null : (
          <Button size="default" stretch onClick={() => props.onCommand({ _tag: "Focus", path: next })}>
            {`Next: ${canvasBaseName(next)}`}
          </Button>
        )}
      </div>
    </>
  )
}

const Phone = ({ shared }: { readonly shared: Shared }) => {
  const { props, world } = shared
  const pr = props.pullRequest
  const failed = failedChecks(props.checks)
  const since = phoneSinceLine(props.reading.context.lastLook, props.timeZone)
  const diff = world.ready && props.state.level === "diff"
  const files = new Map(world.files.map((file) => [file.path, file]))
  const focused = files.get(props.state.focus)
  const modulesOnly = !world.ready || world.overview.mode === "modules"
  const where =
    focused === undefined
      ? ""
      : focused.partition === null
        ? focused.module
        : `${focused.module}, partition ${focused.partition}`
  const mini: Minimap = modulesOnly
    ? { rects: world.overview.regions, files: false, bands: false, viewport: null }
    : { rects: world.overview.regions, files: true, bands: true, viewport: null }
  return (
    <div className="rc-page rc-phone" data-review-canvas="">
      <div className="rc-phead" data-review-canvas-header="">
        <nav className="rc-crumb" aria-label="Breadcrumb">
          <span className="rc-parents">
            <span>
              <a href={props.hrefs.code}>Code</a>
              <span aria-hidden="true">&nbsp;/&nbsp;</span>
            </span>
          </span>
          <span className="rc-cur" aria-current="page">
            Review
          </span>
        </nav>
        {diff ? null : (
          <div className="rc-psum">
            <span className="rc-repo">
              {pr.repository} #{pr.number}
            </span>
            <h1>{pr.title}</h1>
            <span className="rc-muted">
              {phoneChangeLine(world.files)}
              {props.review === null
                ? ""
                : ` ${props.review.reviewer} review, ${timeOfDay(props.review.completedAt, props.timeZone)}.`}
            </span>
            {failed.length === 0 ? null : (
              <span className="rc-mk">
                <StateLabel label={checkWords(failed)} size="compact" tone="critical" />
                <code>{failed.join(", ")}</code>
              </span>
            )}
            {since === null ? null : (
              <span className="rc-mk rc-muted">
                <CanvasGlyph name="clock" size={14} />
                <span>{since}</span>
              </span>
            )}
          </div>
        )}
      </div>
      <main className="rc-pmain">
        {diff ? (
          <PhoneDiff shared={shared} />
        ) : (
          <>
            {world.ready && world.overview.mode === "modules" ? (
              <Notice icon="minus" tone="neutral" data-review-canvas-notice="">
                <span>{noDependencyNotice(world.graph, pr.repository)}</span>
              </Notice>
            ) : null}
            {world.ready ? null : (
              <div role="status" className="rc-mk rc-building" data-review-canvas-notice="">
                <StateLabel label="Building" size="compact" tone="progress" />
                <span>
                  {statusLine(world, props.state, props.reading.graph._tag === "Building" ? props.reading.graph : null)}
                </span>
              </div>
            )}
            {world.ready ? (
              <figure className="rc-pmap" data-review-canvas-minimap="">
                <div
                  className="rc-fr"
                  role="img"
                  aria-label={`Map of the change. ${focused?.name ?? ""} is selected: ${where}.`}
                >
                  <MinimapSvg map={mini} overview={world.overview} selected={props.state.focus} />
                </div>
                <figcaption>
                  Selected: {focused?.name ?? ""}, in {where.replace(", partition", " and partition")}. The map is a
                  picture; the list below is the review.
                </figcaption>
              </figure>
            ) : null}
            {modulesOnly ? <ModuleList shared={shared} /> : <ChapterList shared={shared} />}
          </>
        )}
      </main>
    </div>
  )
}

const ChapterList = ({ shared }: { readonly shared: Shared }) => {
  const files = new Map(shared.world.files.map((file) => [file.path, file]))
  return (
    <div className="rc-plist" data-review-canvas-list="">
      {chapters(shared).map((chapter) => (
        <section key={chapter.title} className="rc-pchap">
          <h2>{chapter.heading}</h2>
          <span>{chapter.meta}</span>
          <ol className="rc-prows">
            {chapter.files.flatMap((path) => {
              const file = files.get(path)
              return file === undefined ? [] : [<PhoneRow key={path} shared={shared} file={file} numbered />]
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}

const ModuleList = ({ shared }: { readonly shared: Shared }) => {
  const modules = Array.from(new Set(shared.world.files.map((file) => file.module)))
  return (
    <div className="rc-plist rc-plist-modules" data-review-canvas-list="">
      {shared.world.ready ? <span className="rc-small">Files by module, no partitions</span> : null}
      {modules.map((module) => (
        <section key={module} className="rc-pchap">
          <h2 className="rc-mono">{module}</h2>
          <ul className="rc-prows" style={{ listStyle: "none" }}>
            {shared.world.files
              .filter((file) => file.module === module)
              .map((file) => (
                <PhoneRow key={file.path} shared={shared} file={file} numbered={false} />
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** The canvas page for one pull request: header, view switch, zoom ladder, and the canvas or the Files list. */
export const ReviewCanvas = (props: ReviewCanvasProps): ReactElement => {
  const narrow = useNarrow()
  const world = useMemo(
    () => canvasWorldOf(props.reading.graph, props.reading.context, props.findings),
    [props.reading, props.findings]
  )
  const notes = props.reading.context.findings._tag === "Recorded" ? props.reading.context.findings.notes : {}
  const shared: Shared = {
    props,
    world,
    notes,
    changed: changedSinceWords(props.reading.context.lastLook, props.timeZone)
  }
  return narrow ? <Phone shared={shared} /> : <Desktop shared={shared} />
}

export type { CanvasCommand, CanvasLevel, CanvasViewState }
