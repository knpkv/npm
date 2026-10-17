/**
 * Code's review canvas for one pull request. Reads the cached detail, the review workspace, the canvas graph and,
 * at Diff zoom, the focused file's text; owns the canvas view state. Read-only: no provider or command client.
 * @module
 */
import type {
  CodeCanvasResult,
  CodeDetail,
  CodeDiffResult,
  CodeReference,
  CodeReviewResult
} from "@knpkv/codecommit-web/host"
import { CodeReadStatusView, parseReviewDiffFile } from "@knpkv/codecommit-web/views"
import { reviewRunReadingForWorkspace } from "@knpkv/review"
import {
  canvasFindings,
  type CanvasCommand,
  type CanvasReading,
  type CanvasViewState,
  canvasWorldOf,
  initialCanvasView,
  reduceCanvasView
} from "@knpkv/review/canvas"
import { ReviewCanvas, type ReviewCanvasChecks, type ReviewCanvasText } from "@knpkv/review/canvas/react"
import { Button, Notice } from "@knpkv/rly/primitives"
import { Effect, Fiber, Result } from "effect"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { CodeModuleReads } from "./code-client.js"
import { codeSelectionSearch, type CodeSelection } from "./code-selection.js"
import { useCodeRead } from "./internal/use-code-read.js"
import { codeModule, moduleHref } from "./modules.js"

const short = (commit: string): string => commit.slice(0, 7)

/** Re-read a building canvas every two seconds until its graph is ready. */
const useCanvasReading = (reads: CodeModuleReads, ref: CodeReference, enabled: boolean, refresh: number) => {
  const [tick, setTick] = useState(0)
  const read = useMemo(() => reads.canvas(ref), [reads.canvas, ref, tick])
  const state = useCodeRead<CodeCanvasResult>(`${ref}:${tick}`, read, enabled, false, refresh)
  const [last, setLast] = useState<{ readonly ref: CodeReference; readonly value: CodeCanvasResult } | null>(null)
  useEffect(() => {
    if (state.value !== null) setLast({ ref, value: state.value })
  }, [state.value, ref])
  const value = state.value ?? (last?.ref === ref ? last.value : null)
  const building = value?._tag === "Ready" && value.reading.graph._tag === "Building"
  // A failed re-read stops the loop: the page shows the failure over the previous reading and waits for Read again.
  useEffect(() => {
    if (!enabled || !building || state.loading || state.failure !== null) return
    const fiber = Effect.runFork(
      Effect.sleep("2 seconds").pipe(Effect.andThen(Effect.sync(() => setTick((n) => n + 1))))
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [enabled, building, state.loading, state.failure])
  return { ...state, value }
}

/**
 * The canvas joins three separate reads: the map, the review and the file list with its lines. A push between them
 * can leave them at different heads. Findings and lines join the map only at the map's own head; `other` names a
 * head another read is already at, so the page can say so and offer to read again.
 */
export const canvasReadHeads = (map: string, review: string | null, lines: string | null) => ({
  findings: review === map,
  lines: lines === map,
  other: [review, lines].find((head) => head !== null && head !== map) ?? null
})

export const CodeCanvasPage = ({
  enabled,
  ownerUIHref,
  reads,
  refresh,
  selection
}: {
  readonly enabled: boolean
  readonly ownerUIHref: string | null
  readonly reads: CodeModuleReads
  readonly refresh: number
  readonly selection: CodeSelection & { readonly ref: CodeReference }
}) => {
  const ref = selection.ref
  // Read again re-reads every source together, on top of the host's own refresh.
  const [again, setAgain] = useState(0)
  const reread = refresh + again
  const readAgain = useCallback(() => setAgain((count) => count + 1), [])
  const detailRead = useMemo(() => reads.detail(ref), [reads.detail, ref])
  const detail = useCodeRead<CodeDetail>(ref, detailRead, enabled, true, reread)
  const reviewRead = useMemo(() => reads.review(ref), [reads.review, ref])
  const review = useCodeRead<CodeReviewResult>(ref, reviewRead, enabled, false, reread)
  const canvas = useCanvasReading(reads, ref, enabled, reread)
  const diffRead = useMemo(() => reads.diff(ref), [reads.diff, ref])
  const diff = useCodeRead<CodeDiffResult>(ref, diffRead, enabled, false, reread)

  const reading: CanvasReading | null = canvas.value?._tag === "Ready" ? canvas.value.reading : null
  const workspace = review.value?._tag === "Ready" ? review.value.reading.workspace : null
  const inventory = diff.value?._tag === "Ready" ? diff.value.diff : null
  const mapHead =
    reading === null
      ? null
      : reading.graph._tag === "Ready"
        ? reading.graph.graph.headRevision
        : reading.graph.headRevision
  const heads =
    mapHead === null
      ? null
      : canvasReadHeads(mapHead, workspace?.identity.headRevision ?? null, inventory?.headCommit ?? null)
  const reviewAtMap = heads !== null && heads.findings ? workspace : null
  const findings = useMemo(() => (reviewAtMap === null ? [] : canvasFindings(reviewAtMap)), [reviewAtMap])
  const world = useMemo(
    () => (reading === null ? null : canvasWorldOf(reading.graph, reading.context, findings)),
    [reading, findings]
  )
  const [view, setView] = useState<{ readonly key: string; readonly state: CanvasViewState } | null>(null)
  const worldKey = world === null ? "none" : JSON.stringify([ref, world.graph.headRevision, world.ready])
  const state = world === null ? null : view?.key === worldKey ? view.state : initialCanvasView(world)
  const onCommand = useCallback(
    (command: CanvasCommand) => {
      if (world === null) return
      setView((current) => ({
        key: worldKey,
        state: reduceCanvasView(world, current?.key === worldKey ? current.state : initialCanvasView(world), command)
      }))
    },
    [world, worldKey]
  )
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set())
  const onToggleHandled = useCallback((finding: string) => {
    setHandled((current) => {
      const next = new Set(current)
      if (next.has(finding)) next.delete(finding)
      else next.add(finding)
      return next
    })
  }, [])

  const linesAtMap = heads !== null && heads.lines
  const focusedFile =
    state === null || inventory === null ? null : (inventory.files.find((file) => file.path === state.focus) ?? null)
  const wantsText = state !== null && state.level === "diff" && focusedFile !== null && inventory !== null && linesAtMap
  const contentQuery = useMemo(
    () =>
      wantsText && focusedFile !== null && inventory !== null
        ? {
            ref,
            revisionId: inventory.revisionId,
            baseCommit: inventory.baseCommit,
            headCommit: inventory.headCommit,
            fileIndex: focusedFile.index
          }
        : null,
    [wantsText, focusedFile, inventory, ref]
  )
  const contentRead = useMemo(
    () => (contentQuery === null ? Effect.never : reads.content(contentQuery)),
    [reads.content, contentQuery]
  )
  const content = useCodeRead(
    JSON.stringify(contentQuery),
    contentRead,
    enabled && contentQuery !== null,
    false,
    refresh
  )
  const text: ReviewCanvasText = useMemo(() => {
    if (inventory !== null && !linesAtMap) {
      return { _tag: "Unavailable", message: "These lines are at another head than the map. Read again." }
    }
    if (contentQuery === null || inventory === null || focusedFile === null) return { _tag: "Loading" }
    if (content.failure !== null) return { _tag: "Unavailable", message: "The lines could not be read. Read again." }
    const value = content.value
    if (value === null) return { _tag: "Loading" }
    if (value._tag === "Unavailable") return { _tag: "Unavailable", message: "The lines are unavailable on this host." }
    const parsed = parseReviewDiffFile(focusedFile, inventory.revisionId, value.content)
    if (Result.isFailure(parsed) || value.content.after === null) {
      return { _tag: "Unavailable", message: "These lines can’t be shown here. Use the Files list." }
    }
    const added = new Set(
      parsed.success.hunks.flatMap((hunk) =>
        hunk.lines.flatMap((line) => (line.kind === "add" && line.newNo !== undefined ? [line.newNo] : []))
      )
    )
    const lines = value.content.after.split("\n")
    if (lines.at(-1) === "") lines.pop()
    return {
      _tag: "Ready",
      readAt: inventory.readAt,
      headCommit: short(inventory.headCommit),
      lines: lines.map((line, index) => ({ number: index + 1, text: line, added: added.has(index + 1) }))
    }
  }, [contentQuery, inventory, focusedFile, content.failure, content.value, linesAtMap])

  const run = reviewAtMap === null ? null : reviewRunReadingForWorkspace(reviewAtMap)
  const reviewMeta =
    run?._tag === "Current"
      ? { reviewer: run.run.profile?.name ?? run.run.kind, completedAt: run.run.completedAt }
      : null
  const checks: ReviewCanvasChecks =
    reviewAtMap === null || reviewAtMap.checks._tag === "Unknown"
      ? { _tag: "Unknown" }
      : {
          _tag: "Ready",
          failed: reviewAtMap.checks.items.filter((check) => check.state === "failed").map((check) => check.name)
        }
  const item = detail.value?._tag === "Ready" ? detail.value : null
  const href = (page: "pull-requests", next: CodeSelection) => moduleHref(codeModule, page, codeSelectionSearch(next))
  const unavailable =
    canvas.value?._tag === "Unavailable" ? canvas.value : detail.value?._tag === "Unavailable" ? detail.value : null

  if (reading === null || item === null || state === null) {
    return (
      <section className="code-canvas-status" data-code-canvas-state={unavailable === null ? "Loading" : "Unavailable"}>
        <CodeReadStatusView
          state={{
            value: unavailable,
            loading: canvas.loading || detail.loading,
            failure: canvas.failure ?? detail.failure
          }}
          ownerUIHref={ownerUIHref}
          loadingLabel="Reading the canvas…"
          presentation="panel"
        />
      </section>
    )
  }
  const readAgainButton = (
    <Button onClick={readAgain} size="dense" variant="quiet">
      Read again
    </Button>
  )
  return (
    <div className="code-canvas" data-code-canvas-state={reading.graph._tag}>
      {/* Always mounted, so a notice added later lands in a live region screen readers already watch. */}
      <div aria-live="polite" role="status">
        {heads?.other != null && mapHead !== null ? (
          <Notice action={readAgainButton} data-code-canvas-heads="" tone="caution">
            The map is for head {short(mapHead)}, and the change is now at {short(heads.other)}.
          </Notice>
        ) : canvas.failure !== null ? (
          <Notice action={readAgainButton} data-code-canvas-failure="" tone="critical">
            Couldn’t read the map again. Previous reading shown.
          </Notice>
        ) : null}
      </div>
      <ReviewCanvas
        pullRequest={{
          repository: item.item.repository,
          number: item.item.id,
          title: item.item.title,
          sourceBranch: item.sourceBranch,
          destinationBranch: item.destinationBranch
        }}
        reading={reading}
        findings={findings}
        review={reviewMeta}
        checks={checks}
        state={state}
        onCommand={onCommand}
        text={text}
        hrefs={{
          code: moduleHref(codeModule, "pull-requests", new URLSearchParams()),
          pullRequests: href("pull-requests", { ...selection, ref: null, file: null, view: "review", thread: null }),
          file: (path) => {
            const index = inventory?.files.find((file) => file.path === path)?.index ?? null
            return moduleHref(
              codeModule,
              "diffs",
              codeSelectionSearch({ ...selection, view: "review", thread: null, file: index })
            )
          }
        }}
        handled={handled}
        onToggleHandled={onToggleHandled}
      />
    </div>
  )
}
