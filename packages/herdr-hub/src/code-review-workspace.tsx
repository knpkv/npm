/** Retained read-only Code review owner. Shell selectors own navigation; no provider or command client. @module */
import type {
  CodeDiff,
  CodeDiffContent,
  CodeReviewResult,
  CodeReviewThreadTarget,
  CodeUnavailable
} from "@knpkv/codecommit-web/host"
import {
  CodeReadStatusView,
  codeReadFailureMessage,
  canRenderCodeText,
  parseReviewDiffFile,
  ReviewWorkspaceView,
  ReviewReadAgainButton,
  reviewThreadElementId,
  reviewWorkspaceThreads,
  useCodeReviewReading,
  type CodeHostPage,
  type CodeReadState,
  type ReviewParsedDiff,
  ReviewDiffFileError
} from "@knpkv/codecommit-web/views"
import { Effect, Result } from "effect"
import { StateLabel } from "@knpkv/rly/primitives"
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { CodeModuleReads } from "./code-client.js"
import { makeCodeReviewNavigation } from "./code-review-navigation.js"
import { codeSelectionSearch, type CodeSelection } from "./code-selection.js"
import { useCodeRead } from "./internal/use-code-read.js"
import { codeModule, moduleHref, type ModulePageMount } from "./modules.js"

const fileFailureWords = {
  binary: "Binary content is not shown.",
  oversized: "This file exceeds the display limit. Use the Code owner UI on the credential host to inspect it.",
  display_limit: "This file exceeds the display limit. Use the Code owner UI on the credential host to inspect it.",
  wrong_content: "The hub returned an unexpected reading.",
  invalid_patch: "The hub returned an unexpected reading."
} satisfies Record<ReviewDiffFileError["reason"], string>

interface ReviewFileReading {
  readonly file: CodeDiff["files"][number]
  readonly unavailable: CodeUnavailable | null
  readonly parsed: ReturnType<typeof parseReviewDiffFile> | null
  readonly raw: CodeDiffContent | null
  readonly failure: CodeReadState<never>["failure"]
}

const retainedResult = (state: ReturnType<typeof useCodeReviewReading>["state"]): CodeReviewResult | null => {
  switch (state._tag) {
    case "Ready":
    case "Retained":
      return state.value
    case "Loading":
    case "Paused":
      return state.previous
    case "Idle":
    case "Failed":
      return null
  }
}
const usable = (target: HTMLElement) =>
  target.isConnected &&
  target.closest('[hidden], [inert], [aria-hidden="true"]') === null &&
  target.getClientRects().length > 0

/**
 * Keep the controller and focus owner across changing bodies. A route target arms one focus intent,
 * waits for a current same-ref Ready read and disclosure mount, then is consumed after focus succeeds.
 * Refreshes never re-arm it. Inactive/hidden owners and another modal's focus are never taken.
 */
export function useCodeReviewWorkspace({
  enabled,
  mount,
  ownerUIHref,
  page,
  reads,
  selection
}: {
  readonly enabled: boolean
  readonly mount: ModulePageMount
  readonly ownerUIHref: string | null
  readonly page: CodeHostPage
  readonly reads: CodeModuleReads
  readonly selection: CodeSelection
}) {
  const owner = useRef<HTMLElement>(null)
  const instance = useId()
  const scope = JSON.stringify(["hub-code", page, instance])
  const [, wakeFocus] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const controller = useCodeReviewReading({ ref: selection.ref, enabled, read: reads.review })
  const result = retainedResult(controller.state)
  const wrongSubject = result?._tag === "Ready" && result.reading.workspace.identity.subjectId !== selection.ref
  const reading = result?._tag === "Ready" && !wrongSubject ? result.reading : null
  const revisionKey =
    reading === null
      ? "none"
      : JSON.stringify([
          reading.workspace.identity,
          reading.workspace.run._tag === "Ready" ? reading.workspace.run.run.identity : null
        ])
  const [secondary, setSecondary] = useState({ revision: revisionKey, open: false })
  const secondaryOpen = secondary.revision === revisionKey && secondary.open
  const intentKey = JSON.stringify([
    selection.ref,
    page,
    selection.view,
    selection.file,
    selection.thread,
    mount.active
  ])
  const intent = useRef({ key: intentKey, consumed: false })
  const selectedFile = reading?.diff.files.find((entry) => entry.index === selection.file) ?? null
  const contentQueries = useMemo(() => {
    const ref = selection.ref
    return selection.view === "review" && ref !== null && reading !== null
      ? (selection.file === null ? reading.diff.files : selectedFile === null ? [] : [selectedFile]).map((file) => ({
          file,
          query: {
            ref,
            revisionId: reading.diff.revisionId,
            baseCommit: reading.diff.baseCommit,
            headCommit: reading.diff.headCommit,
            fileIndex: file.index
          }
        }))
      : []
  }, [selection.view, selection.ref, selection.file, reading, selectedFile])
  const contentRead = useMemo(
    () =>
      Effect.gen(function* () {
        const files: Array<ReviewFileReading> = []
        let before: string | null = null
        let after: string | null = null
        for (const { file, query } of contentQueries) {
          const fetched = yield* Effect.result(reads.content(query))
          if (Result.isFailure(fetched)) {
            files.push({ file, unavailable: null, parsed: null, raw: null, failure: fetched.failure.reason })
            continue
          }
          const result = fetched.success
          if (result._tag === "Unavailable") {
            files.push({ file, unavailable: result, parsed: null, raw: null, failure: null })
            continue
          }
          // Refuse a foreign response before it can affect the current reading's display budget.
          if (result.content.revisionId !== query.revisionId || result.content.fileIndex !== file.index) {
            files.push({
              file,
              unavailable: null,
              raw: null,
              failure: null,
              parsed: Result.fail(new ReviewDiffFileError({ reason: "wrong_content" }))
            })
            continue
          }
          // Bound the whole rendered reading before any synchronous diff computation.
          const nextBefore: string | null =
            result.content.before === null
              ? before
              : before === null
                ? result.content.before
                : before + "\n" + result.content.before
          const nextAfter: string | null =
            result.content.after === null
              ? after
              : after === null
                ? result.content.after
                : after + "\n" + result.content.after
          const withinBudget = result.content.state !== "text" || canRenderCodeText(nextBefore, nextAfter)
          const parsed = withinBudget
            ? parseReviewDiffFile(file, query.revisionId, result.content)
            : Result.fail(new ReviewDiffFileError({ reason: "display_limit" }))
          const rendersText = Result.isSuccess(parsed) || parsed.failure.reason === "invalid_patch"
          if (rendersText && result.content.state === "text") {
            before = nextBefore
            after = nextAfter
          }
          files.push({
            file,
            unavailable: null,
            parsed,
            failure: null,
            raw: Result.isFailure(parsed) && parsed.failure.reason === "invalid_patch" ? result.content : null
          })
        }
        return files
      }),
    [reads.content, contentQueries]
  )
  const content = useCodeRead<ReadonlyArray<ReviewFileReading>>(
    JSON.stringify(contentQueries),
    contentRead,
    enabled && controller.state._tag === "Ready" && contentQueries.length > 0,
    false,
    refresh
  )
  const parsedDiff: ReviewParsedDiff | null =
    reading === null
      ? null
      : {
          identity: reading.workspace.identity,
          files: (content.value ?? []).flatMap(({ file, parsed }) =>
            parsed !== null && Result.isSuccess(parsed) ? [{ index: file.index, file: parsed.success }] : []
          )
        }

  useEffect(() => {
    if (
      !enabled ||
      controller.state._tag !== "Ready" ||
      reading === null ||
      selection.file === null ||
      selectedFile !== null
    )
      return
    mount.navigate(moduleHref(codeModule, page, codeSelectionSearch({ ...selection, file: null })), "replace", null)
  }, [enabled, controller.state._tag, reading, selection, selectedFile, mount.navigate, page])

  useLayoutEffect(() => {
    if (intent.current.key !== intentKey) intent.current = { key: intentKey, consumed: false }
    if (
      intent.current.consumed ||
      selection.thread === null ||
      !enabled ||
      !mount.active ||
      reading === null ||
      controller.state._tag !== "Ready" ||
      owner.current === null ||
      !usable(owner.current)
    )
      return
    // Do not focus a fallback that a pending selected file will shortly move inline.
    if (contentQueries.length > 0 && (content.loading || (content.value === null && content.failure === null))) return
    if (selection.file !== null && selectedFile === null) return
    const focused = owner.current.ownerDocument.activeElement
    const modal = focused?.closest('[role="dialog"], [role="alertdialog"]')
    if (
      modal !== null &&
      modal !== undefined &&
      modal !== owner.current.closest('[role="dialog"], [role="alertdialog"]')
    )
      return
    const joined = reviewWorkspaceThreads(reading.workspace)
    if (Result.isFailure(joined)) return
    const target = selection.thread
    if (
      selection.view === "review" &&
      joined.success.secondary.some((row) => row.thread.source === target.source && row.thread.id === target.id) &&
      !secondaryOpen
    ) {
      setSecondary({ revision: revisionKey, open: true })
      return
    }
    // The diff measures its container during commit and may replace split annotation rows.
    // Resolve the target after that commit instead of consuming focus on a soon-detached card.
    const frame = window.requestAnimationFrame(() => {
      const currentOwner = owner.current
      if (currentOwner === null || !usable(currentOwner)) return
      const currentModal = currentOwner.ownerDocument.activeElement?.closest('[role="dialog"], [role="alertdialog"]')
      if (
        currentModal !== null &&
        currentModal !== undefined &&
        currentModal !== currentOwner.closest('[role="dialog"], [role="alertdialog"]')
      )
        return
      const id = reviewThreadElementId(JSON.stringify([scope, selection.ref, selection.view]), target)
      const element = currentOwner.querySelector<HTMLElement>(`#${id}`)
      if (element === null || !usable(element)) return
      element.focus({ preventScroll: true })
      if (currentOwner.ownerDocument.activeElement === element) {
        intent.current.consumed = true
        element.scrollIntoView({ block: "nearest" })
      }
    })
    return () => window.cancelAnimationFrame(frame)
  })

  const readAgain = () => {
    controller.readAgain()
    setRefresh((n) => n + 1)
  }
  const failure =
    controller.state._tag === "Failed" || controller.state._tag === "Retained"
      ? controller.state.failure._tag === "Expected"
        ? controller.state.failure.reason
        : "status"
      : wrongSubject
        ? "invalid_response"
        : null
  const state: CodeReadState<Extract<CodeReviewResult, { readonly _tag: "Unavailable" }>> = {
    value: result?._tag === "Unavailable" ? result : null,
    loading: controller.state._tag === "Loading",
    failure
  }
  const selectionWithRef = selection.ref === null ? null : { ...selection, ref: selection.ref }
  const navigation =
    selectionWithRef === null
      ? null
      : makeCodeReviewNavigation({ page, selection: selectionWithRef, navigate: mount.navigate })
  const openThread = (target: CodeReviewThreadTarget) => {
    // A deliberate activation of the same URL still owns focus, even if shell history deduplicates it.
    if (
      selection.view === "review" &&
      selection.thread?.source === target.source &&
      selection.thread.id === target.id
    ) {
      intent.current.consumed = false
      wakeFocus((n) => n + 1)
    }
    navigation?.onOpenThread(target)
  }
  const previous =
    controller.state._tag === "Retained" ||
    (controller.state._tag === "Loading" && controller.state.previous !== null) ||
    (controller.state._tag === "Paused" && controller.state.previous !== null)
  const clock =
    reading === null
      ? null
      : new Intl.DateTimeFormat(undefined, { hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(
          reading.workspace.observedAt
        )
  const navigateView = (view: CodeSelection["view"]) =>
    mount.navigate(
      moduleHref(codeModule, page, codeSelectionSearch({ ...selection, view, thread: null })),
      "push",
      null
    )
  const hasWorkspaceRetry =
    reading !== null &&
    (reading.workspace.run._tag === "Unavailable" ||
      reading.workspace.conversations._tag === "Unavailable" ||
      Result.isFailure(reviewWorkspaceThreads(reading.workspace)))
  const contentNeedsRetry =
    content.failure !== null || (content.value ?? []).some((file) => file.failure !== null || file.unavailable !== null)
  const needsHostRetry = failure !== null || result?._tag === "Unavailable" || contentNeedsRetry
  const retryInDiff = reading !== null && failure === null && result?._tag === "Ready" && contentNeedsRetry
  const diffRetry =
    retryInDiff && !hasWorkspaceRetry ? (
      <ReviewReadAgainButton focusTarget={() => owner.current} onReadAgain={readAgain} />
    ) : null
  const retryFilePosition =
    content.failure === null
      ? (content.value ?? []).findIndex((file) => file.failure !== null || file.unavailable !== null)
      : -1
  const announceEnabled = enabled && (owner.current === null || usable(owner.current))
  const announcement = !announceEnabled
    ? ""
    : state.loading
      ? "Reading cached details…"
      : failure !== null
        ? codeReadFailureMessage(failure)
        : result?._tag === "Unavailable"
          ? "Code unavailable"
          : controller.completion !== null && reading !== null
            ? `Read ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(reading.workspace.observedAt)}.`
            : ""
  const statusContent = (
    <>
      <CodeReadStatusView
        state={state}
        ownerUIHref={ownerUIHref}
        loadingLabel="Reading cached details…"
        announce={false}
        presentation="panel"
      />
      {previous && clock !== null ? <p className="code-host-problem">Previous reading {clock}.</p> : null}
      {needsHostRetry && !hasWorkspaceRetry && !retryInDiff ? (
        <ReviewReadAgainButton focusTarget={() => owner.current} onReadAgain={readAgain} />
      ) : null}
    </>
  )
  const statusBeforeDetail = previous && reading !== null
  const beforeDetail =
    statusBeforeDetail && selection.ref !== null && page !== "diffs" ? (
      <div className="code-review-status" data-code-review-retained="" data-code-read-notice="retained">
        <div className="code-review-status-copy">
          {failure !== null ? (
            <StateLabel icon="alert" label={codeReadFailureMessage(failure)} size="compact" tone="caution" />
          ) : state.loading ? (
            <p>Reading cached details…</p>
          ) : null}
          {clock === null ? null : <p className="code-host-problem">Previous reading {clock}.</p>}
        </div>
        {needsHostRetry && !hasWorkspaceRetry && !retryInDiff ? (
          <ReviewReadAgainButton focusTarget={() => owner.current} onReadAgain={readAgain} />
        ) : null}
      </div>
    ) : undefined
  const node =
    selection.ref === null || page === "diffs" ? undefined : (
      <section
        ref={owner}
        tabIndex={-1}
        aria-label="Review workspace"
        data-code-review-owner=""
        data-code-review-ref={selection.ref}
        data-code-review-read-state={controller.state._tag}
        data-code-review-files-state={
          contentQueries.length === 0
            ? "Idle"
            : content.loading
              ? "Loading"
              : content.failure !== null || (content.value ?? []).some((file) => file.failure !== null)
                ? "Failed"
                : content.value === null
                  ? "Loading"
                  : "Ready"
        }
      >
        <p
          className="code-review-read-announcement"
          data-code-review-announcement=""
          role="status"
          aria-live={announceEnabled ? "polite" : "off"}
          aria-atomic="true"
        >
          <span
            key={controller.completion?.id ?? controller.state._tag}
            data-completed-read={controller.completion?.id}
          >
            {announcement}
          </span>
        </p>
        {reading !== null ? (
          <nav className="code-host-tabs" aria-label="Review views">
            {(["review", "conversation"] satisfies ReadonlyArray<CodeSelection["view"]>).map((view) => (
              <a
                key={view}
                href={moduleHref(codeModule, page, codeSelectionSearch({ ...selection, view, thread: null }))}
                aria-current={selection.view === view ? "page" : undefined}
                onClick={(event) => {
                  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
                  event.preventDefault()
                  navigateView(view)
                }}
              >
                {view === "review" ? "Review" : "Conversation"}
              </a>
            ))}
          </nav>
        ) : null}
        {statusBeforeDetail ? null : statusContent}
        {reading !== null && navigation !== null ? (
          <>
            <ReviewWorkspaceView
              workspace={reading.workspace}
              presentation={selection.view}
              scope={scope}
              secondary={{ open: secondaryOpen, onOpenChange: (open) => setSecondary({ revision: revisionKey, open }) }}
              focusTarget={() => owner.current}
              onReadAgain={readAgain}
              hrefForThread={navigation.hrefForThread}
              onOpenThread={openThread}
              parsedDiff={
                parsedDiff === null
                  ? undefined
                  : {
                      parsed: parsedDiff,
                      renderFailure: () => (
                        <CodeReadStatusView
                          state={{ value: null, loading: false, failure: "invalid_response" }}
                          ownerUIHref={ownerUIHref}
                          loadingLabel="Reading file…"
                          presentation="panel"
                        />
                      )
                    }
              }
              diff={
                <>
                  {contentQueries.length === 0 ? null : (
                    <CodeReadStatusView
                      state={{ value: null, loading: content.loading, failure: content.failure }}
                      action={content.failure !== null ? diffRetry : undefined}
                      ownerUIHref={ownerUIHref}
                      loadingLabel="Reading file…"
                      presentation="panel"
                    />
                  )}
                  {(content.value ?? []).map(({ failure, file, parsed, raw, unavailable }, position) =>
                    unavailable === null && failure === null && (parsed === null || Result.isSuccess(parsed)) ? null : (
                      <section key={`${file.index}-${position}`} data-code-review-raw="">
                        <h3>{file.path}</h3>
                        <CodeReadStatusView
                          state={{ value: unavailable, loading: false, failure }}
                          action={position === retryFilePosition ? diffRetry : undefined}
                          ownerUIHref={ownerUIHref}
                          loadingLabel="Reading file…"
                          presentation="panel"
                        />
                        {parsed !== null && Result.isFailure(parsed) ? (
                          <div className="code-review-status" data-code-read-notice="failure" role="status">
                            <StateLabel
                              icon="alert"
                              label={fileFailureWords[parsed.failure.reason]}
                              size="compact"
                              tone="caution"
                            />
                          </div>
                        ) : null}
                        {raw === null ? null : (
                          <div className="code-host-file-columns">
                            <section>
                              <h3>Before</h3>
                              <pre tabIndex={0}>{raw.before ?? "File not present"}</pre>
                            </section>
                            <section>
                              <h3>After</h3>
                              <pre tabIndex={0}>{raw.after ?? "File not present"}</pre>
                            </section>
                          </div>
                        )}
                      </section>
                    )
                  )}
                </>
              }
            />
          </>
        ) : null}
      </section>
    )
  const checks =
    reading === null ? null : reading.workspace.checks._tag === "Unknown" ? (
      <StateLabel icon="minus" label="Checks unknown" tone="neutral" size="compact" />
    ) : (
      <ul aria-label="Checks">
        {reading.workspace.checks.items.map((check) => (
          <li key={check.id}>
            {check.name}: {check.state}
          </li>
        ))}
      </ul>
    )
  return { node, beforeDetail, readAgain, checks, status: state }
}
