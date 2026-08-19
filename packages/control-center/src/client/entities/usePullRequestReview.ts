import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import type {
  AgentProviderCatalog,
  AgentProviderCatalogEntry,
  DurableAgentPrompt,
  PublishedReviewComment,
  PullRequestReviewState,
  PullRequestReviewThreadPage,
  ReleaseAgentThreadCursor,
  ReviewSuggestionPublicationContent,
  ReviewSuggestionPublicationOperation,
  ReviewSuggestionPublicationPreview,
  ReviewSuggestionPublicationSelection
} from "../../api/agent.js"
import type { RateLimitedApiError } from "../../api/errors.js"
import type { EntityId, JobId, PrReviewSuggestionRevisionId } from "../../domain/identifiers.js"
import type { PrReviewSuggestionId } from "../../domain/prReview.js"
import type { PrReviewSuggestionRevisionSequence } from "../../domain/prReviewRevision.js"
import {
  isRecoverablePullRequestReviewFailure,
  isUnauthorizedPullRequestReviewFailure
} from "./pullRequestReviewFailures.js"
import type { PullRequestReviewThread } from "./pullRequestReviewThreadReplay.js"

const pullRequestReviewBrowser = import("./pullRequestReviewThreadReplay.js")
const generatedClientTransport = pullRequestReviewBrowser.then(
  ({ generatedClientPullRequestReviewTransport }) => generatedClientPullRequestReviewTransport
)

const isRateLimitedReviewFailure = <UnparsedInput>(
  failure: UnparsedInput
): failure is UnparsedInput & RateLimitedApiError => Predicate.isTagged(failure, "RateLimitedApiError")

const waitBeforeAutomaticReviewRetry = <UnparsedInput>(failure?: UnparsedInput): Effect.Effect<void> => {
  if (!isRateLimitedReviewFailure(failure)) return Effect.sleep(Duration.seconds(1))
  const retryAt = failure.retryAt
  if (retryAt === null) return Effect.sleep(Duration.seconds(2))
  return Effect.flatMap(DateTime.now, (now) =>
    Effect.sleep(
      Duration.millis(
        Math.max(0, DateTime.toEpochMillis(retryAt) - DateTime.toEpochMillis(now))
      )
    ))
}

interface ReviewProviderSelection {
  readonly displayName?: NonNullable<AgentProviderCatalogEntry["displayName"]>
  readonly model: AgentProviderCatalogEntry["models"][number]
  readonly providerId: AgentProviderCatalogEntry["providerId"]
  readonly reviewProfile: NonNullable<AgentProviderCatalogEntry["reviewProfile"]>
}

export interface PullRequestReviewScope {
  readonly baseRevision: string | null
  readonly entityId: EntityId
  readonly headRevision: string
  readonly sessionKey: string
}

/** Browser selection resolved to an exact revision before publication preview. */
export type ReviewSuggestionPublicationTarget = Pick<
  ReviewSuggestionPublicationSelection,
  "jobId" | "revisionId" | "suggestionId"
>

/** Exact immutable revision selected for one targeted agent operation. */
export type ReviewSuggestionTarget = {
  readonly expectedRevisionId: PrReviewSuggestionRevisionId
  readonly expectedSequence: PrReviewSuggestionRevisionSequence
  readonly intent: "suggestion-edit" | "suggestion-revalidation"
  readonly jobId: JobId
  readonly suggestionId: PrReviewSuggestionId
}

export type PullRequestReviewControllerState =
  | { readonly _tag: "idle" }
  | ({ readonly _tag: "loading" } & PullRequestReviewScope)
  | ({ readonly _tag: "failed" } & PullRequestReviewScope)
  | ({
    readonly _tag: "ready"
    readonly action: "idle" | "starting" | "failed"
    readonly historyAction: "idle" | "loading" | "failed"
    readonly provider: ReviewProviderSelection | null
    /** Ordered launch presets; `provider` remains the default for older callers. */
    readonly providerPresets?: ReadonlyArray<ReviewProviderSelection>
    readonly review: PullRequestReviewState
    readonly thread?: PullRequestReviewThread
  } & PullRequestReviewScope)

export type PullRequestReviewPublicationState =
  | { readonly _tag: "idle" }
  | {
    readonly _tag: "previewing"
    readonly selection: ReviewSuggestionPublicationTarget
  }
  | {
    readonly _tag: "preview"
    readonly preview: ReviewSuggestionPublicationPreview
  }
  | {
    readonly _tag: "publishing"
    readonly preview: ReviewSuggestionPublicationPreview
  }
  | {
    readonly _tag: "published"
    readonly headSuperseded: boolean
    readonly preview: ReviewSuggestionPublicationPreview
    readonly publication: PublishedReviewComment
  }
  | {
    readonly _tag: "receipt-conflict"
    readonly preview: ReviewSuggestionPublicationPreview
    readonly publication: PublishedReviewComment
  }
  | {
    readonly _tag: "failed"
    readonly preview: ReviewSuggestionPublicationPreview | null
    readonly selection: ReviewSuggestionPublicationTarget
  }

/** Browser boundary for immutable pull-request review reads and mutations. */
export interface PullRequestReviewTransport {
  readonly enqueue: (
    entityId: EntityId,
    provider: ReviewProviderSelection,
    prompt: DurableAgentPrompt | undefined,
    signal: AbortSignal
  ) => Promise<PullRequestReviewState>
  readonly cancel?: (entityId: EntityId, jobId: JobId, signal: AbortSignal) => Promise<PullRequestReviewState>
  readonly extendBudget?: (entityId: EntityId, jobId: JobId, signal: AbortSignal) => Promise<PullRequestReviewState>
  readonly load: (entityId: EntityId, signal: AbortSignal) => Promise<PullRequestReviewState>
  readonly loadThread: (
    entityId: EntityId,
    cursor: ReleaseAgentThreadCursor | null,
    signal: AbortSignal,
    direction?: "after" | "before"
  ) => Promise<PullRequestReviewThreadPage>
  readonly previewPublication: (
    entityId: EntityId,
    selection: ReviewSuggestionPublicationTarget,
    signal: AbortSignal,
    operation?: ReviewSuggestionPublicationOperation,
    commentId?: string
  ) => Promise<ReviewSuggestionPublicationPreview>
  readonly providers: (signal: AbortSignal) => Promise<AgentProviderCatalog>
  readonly publishSuggestion: (
    entityId: EntityId,
    selection: ReviewSuggestionPublicationSelection,
    finalContent: ReviewSuggestionPublicationContent,
    authorityBinding: ReviewSuggestionPublicationPreview["authorityBinding"],
    signal: AbortSignal,
    operation?: ReviewSuggestionPublicationOperation,
    commentId?: string
  ) => Promise<PublishedReviewComment>
  readonly targetSuggestion?: (
    entityId: EntityId,
    target: ReviewSuggestionTarget,
    provider: ReviewProviderSelection,
    signal: AbortSignal
  ) => Promise<PullRequestReviewState>
}

const eligibleProviders = (catalog: AgentProviderCatalog): ReadonlyArray<ReviewProviderSelection> => {
  const eligible = new Array<ReviewProviderSelection>()
  for (const provider of catalog.providers) {
    const model = provider.models[0]
    if (
      provider.health === "available" &&
      provider.capabilities.includes("pr-review") &&
      provider.reviewProfile !== undefined &&
      model
    ) {
      eligible.push({
        providerId: provider.providerId,
        model,
        reviewProfile: provider.reviewProfile,
        ...(!(provider.displayName === undefined) && { displayName: provider.displayName })
      })
    }
  }
  return eligible
}

/** Generated-client transport for the authenticated immutable-review contract. */
export const browserPullRequestReviewTransport: PullRequestReviewTransport = {
  enqueue: (...args) => generatedClientTransport.then((transport) => transport.enqueue(...args)),
  cancel: (...args) => generatedClientTransport.then((transport) => transport.cancel!(...args)),
  extendBudget: (...args) => generatedClientTransport.then((transport) => transport.extendBudget!(...args)),
  load: (...args) => generatedClientTransport.then((transport) => transport.load(...args)),
  loadThread: (...args) => generatedClientTransport.then((transport) => transport.loadThread(...args)),
  previewPublication: (...args) => generatedClientTransport.then((transport) => transport.previewPublication(...args)),
  providers: (...args) => generatedClientTransport.then((transport) => transport.providers(...args)),
  publishSuggestion: (...args) => generatedClientTransport.then((transport) => transport.publishSuggestion(...args)),
  targetSuggestion: (...args) => generatedClientTransport.then((transport) => transport.targetSuggestion!(...args))
}

const sameReviewScope = (
  left: PullRequestReviewScope,
  right: PullRequestReviewScope
): boolean =>
  left.baseRevision === right.baseRevision &&
  left.entityId === right.entityId &&
  left.headRevision === right.headRevision &&
  left.sessionKey === right.sessionKey

/** Observe the lazy history boundary so a missing browser chunk remains retryable. */
export const observePullRequestReviewHistoryLoad = (
  task: Promise<void>,
  signal: AbortSignal,
  current: PullRequestReviewControllerState & PullRequestReviewScope,
  latestScope: { readonly current: PullRequestReviewScope | null },
  setState: (
    update: (state: PullRequestReviewControllerState) => PullRequestReviewControllerState
  ) => void
): void => {
  task.catch(<UnparsedInput>(failure: UnparsedInput) => {
    if (
      signal.aborted ||
      latestScope.current === null ||
      !sameReviewScope(latestScope.current, current)
    ) return
    Effect.runFork(Effect.logError("Pull-request review history boundary failed", failure))
    setState((latest) =>
      latest._tag === "ready" && sameReviewScope(latest, current)
        ? { ...latest, historyAction: "failed" }
        : latest
    )
  })
}

/** Publish the shared merged replay, not an older async caller snapshot. */
export const publishNewestPullRequestReviewThread = (
  candidate: PullRequestReviewThread,
  signal: AbortSignal,
  current: PullRequestReviewScope,
  latestScope: { readonly current: PullRequestReviewScope | null },
  latestThread: { readonly current: PullRequestReviewThread | null },
  setState: (
    update: (state: PullRequestReviewControllerState) => PullRequestReviewControllerState
  ) => void
): void => {
  if (
    signal.aborted ||
    latestScope.current === null ||
    !sameReviewScope(latestScope.current, current)
  ) return
  setState((latest) =>
    latest._tag === "ready" && sameReviewScope(latest, current)
      ? { ...latest, thread: latestThread.current ?? candidate }
      : latest
  )
}

const matchesScope = (
  review: PullRequestReviewState,
  scope: PullRequestReviewScope
): boolean =>
  review._tag === "unavailable" ||
  (
    review.subject.baseRevision === scope.baseRevision &&
    review.subject.headRevision === scope.headRevision
  )

/** Keep review state scoped to the exact entity and authenticated browser session. */
export const usePullRequestReview = (
  entityId: EntityId,
  baseRevision: string | null,
  headRevision: string | null,
  sessionKey: string | null,
  canEnqueue: boolean,
  onSessionExpired: (sessionKey: string) => void,
  transport: PullRequestReviewTransport = browserPullRequestReviewTransport
) => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<PullRequestReviewControllerState>({ _tag: "idle" })
  const [publication, setPublication] = useState<PullRequestReviewPublicationState>({ _tag: "idle" })
  const historyAbort = useRef<AbortController | null>(null)
  const mutationAbort = useRef<AbortController | null>(null)
  const publicationAbort = useRef<AbortController | null>(null)
  const automaticRetryScope = useRef<PullRequestReviewScope | null>(null)
  const latestScope = useRef<PullRequestReviewScope | null>(null)
  const latestThread = useRef<PullRequestReviewThread | null>(null)
  const scope = useMemo(
    () =>
      sessionKey === null || headRevision === null
        ? null
        : { baseRevision, entityId, headRevision, sessionKey },
    [baseRevision, entityId, headRevision, sessionKey]
  )
  useLayoutEffect(() => {
    latestScope.current = scope
  }, [scope])
  useLayoutEffect(() => {
    latestThread.current = null
  }, [entityId, sessionKey])

  useEffect(() => {
    if (sessionKey === null || headRevision === null) {
      setState({ _tag: "idle" })
      return
    }
    const scope = { baseRevision, entityId, headRevision, sessionKey } satisfies PullRequestReviewScope
    const previousThread = latestThread.current ?? undefined
    const abort = new AbortController()
    const scheduleAutomaticRetry = <UnparsedInput>(message: string, failure?: UnparsedInput): boolean => {
      if (
        automaticRetryScope.current !== null &&
        sameReviewScope(automaticRetryScope.current, scope)
      ) return false
      automaticRetryScope.current = scope
      Effect.runFork(Effect.logWarning(message, failure))
      Effect.runPromise(waitBeforeAutomaticReviewRetry(failure), { signal: abort.signal }).then(
        () => {
          if (!abort.signal.aborted) setRequestRevision((revision) => revision + 1)
        },
        <UnparsedInput>(_retryFailure: UnparsedInput) => {
          if (!abort.signal.aborted) setState({ _tag: "failed", ...scope })
        }
      )
      return true
    }
    setState((current) =>
      current._tag === "ready" && sameReviewScope(current, scope)
        ? current
        : { _tag: "loading", ...scope }
    )
    pullRequestReviewBrowser.then(
      ({ loadPullRequestReviewSnapshot }) =>
        loadPullRequestReviewSnapshot(
          transport,
          entityId,
          canEnqueue,
          abort.signal,
          previousThread,
          latestThread
        )
    ).then(
      ({ catalog, catalogNeedsRetry, review, thread }) => {
        if (!abort.signal.aborted) {
          if (!catalogNeedsRetry) automaticRetryScope.current = null
          const providerPresets = eligibleProviders(catalog)
          setState(
            matchesScope(review, scope)
              ? {
                _tag: "ready",
                ...scope,
                action: "idle",
                historyAction: "idle",
                provider: providerPresets[0] ?? null,
                providerPresets,
                review,
                thread
              }
              : { _tag: "failed", ...scope }
          )
          if (catalogNeedsRetry) {
            scheduleAutomaticRetry("Pull-request review provider catalog unavailable; retrying once")
          }
        }
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedPullRequestReviewFailure(failure)) {
          onSessionExpired(sessionKey)
          setState({ _tag: "failed", ...scope })
          return
        }
        if (
          isRecoverablePullRequestReviewFailure(failure) &&
          scheduleAutomaticRetry(
            "Pull-request review snapshot load failed; retrying once",
            failure
          )
        ) {
          return
        }
        setState({ _tag: "failed", ...scope })
      }
    )
    return () => abort.abort()
  }, [
    baseRevision,
    canEnqueue,
    entityId,
    headRevision,
    onSessionExpired,
    requestRevision,
    sessionKey,
    transport
  ])

  useEffect(() => {
    if (state._tag !== "ready" || state.review._tag !== "pending") return
    const abort = new AbortController()
    Effect.runPromise(Effect.sleep("2 seconds"), { signal: abort.signal }).then(
      () => {
        if (!abort.signal.aborted) setRequestRevision((revision) => revision + 1)
      },
      <UnparsedInput>(_failure: UnparsedInput) => {
        if (!abort.signal.aborted) {
          setState({
            _tag: "failed",
            baseRevision: state.baseRevision,
            entityId: state.entityId,
            headRevision: state.headRevision,
            sessionKey: state.sessionKey
          })
        }
      }
    )
    return () => abort.abort()
  }, [state])

  useEffect(
    () => () => {
      historyAbort.current?.abort()
      mutationAbort.current?.abort()
      publicationAbort.current?.abort()
    },
    []
  )
  useEffect(() => {
    historyAbort.current?.abort()
    historyAbort.current = null
    mutationAbort.current?.abort()
    mutationAbort.current = null
    publicationAbort.current?.abort()
    publicationAbort.current = null
    setPublication({ _tag: "idle" })
  }, [entityId, sessionKey])
  useLayoutEffect(() => {
    mutationAbort.current?.abort()
    mutationAbort.current = null
    setPublication((current) => current._tag === "publishing" ? current : { _tag: "idle" })
  }, [baseRevision, headRevision])

  const refreshThread = useCallback((
    refreshScope: PullRequestReviewScope,
    signal: AbortSignal
  ): void => {
    const previous = latestThread.current ?? undefined
    pullRequestReviewBrowser.then(
      ({ refreshPullRequestReviewThread }) =>
        refreshPullRequestReviewThread(
          transport,
          refreshScope.entityId,
          signal,
          previous,
          latestThread
        )
    ).then(
      (thread) => {
        publishNewestPullRequestReviewThread(
          thread,
          signal,
          refreshScope,
          latestScope,
          latestThread,
          setState
        )
      },
      () => undefined
    )
  }, [transport])

  const loadEarlier = useCallback(() => {
    if (
      state._tag !== "ready" ||
      state.historyAction === "loading" ||
      state.thread === undefined ||
      !state.thread.hasEarlier
    ) return
    const current = state
    const currentThread = state.thread
    historyAbort.current?.abort()
    const abort = new AbortController()
    historyAbort.current = abort
    setState({ ...current, historyAction: "loading" })
    observePullRequestReviewHistoryLoad(
      pullRequestReviewBrowser.then(
        ({ loadEarlierPullRequestReviewThreadIntoState }) =>
          loadEarlierPullRequestReviewThreadIntoState(
            transport,
            current,
            currentThread,
            abort.signal,
            latestScope,
            latestThread,
            onSessionExpired,
            setState
          )
      ),
      abort.signal,
      current,
      latestScope,
      setState
    )
  }, [onSessionExpired, state, transport])

  const start = useCallback((
    prompt?: DurableAgentPrompt,
    providerId?: ReviewProviderSelection["providerId"]
  ) => {
    if (state._tag !== "ready" || state.review._tag === "unavailable") return
    const provider = providerId === undefined
      ? state.provider
      : state.providerPresets?.find((candidate) => candidate.providerId === providerId) ?? null
    if (provider === null) return
    const current = state
    mutationAbort.current?.abort()
    const abort = new AbortController()
    mutationAbort.current = abort
    setState({ ...current, action: "starting" })
    transport.enqueue(entityId, provider, prompt, abort.signal).then(
      (review) => {
        if (abort.signal.aborted) return
        setState((latest) =>
          latest._tag === "ready" &&
            sameReviewScope(latest, current) &&
            matchesScope(review, current)
            ? { ...latest, action: "idle", review }
            : latest._tag === "ready" && sameReviewScope(latest, current)
            ? {
              _tag: "failed",
              baseRevision: current.baseRevision,
              entityId: current.entityId,
              headRevision: current.headRevision,
              sessionKey: current.sessionKey
            }
            : latest
        )
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedPullRequestReviewFailure(failure)) onSessionExpired(current.sessionKey)
        setState((latest) =>
          latest._tag === "ready" && sameReviewScope(latest, current)
            ? { ...latest, action: "failed" }
            : latest
        )
      }
    )
  }, [entityId, onSessionExpired, state, transport])

  const mutatePendingReview = useCallback((
    operation: (jobId: JobId, signal: AbortSignal) => Promise<PullRequestReviewState>
  ) => {
    if (state._tag !== "ready") return
    const review = state.review
    if (review._tag !== "pending") return
    const current = state
    mutationAbort.current?.abort()
    const abort = new AbortController()
    mutationAbort.current = abort
    operation(review.jobId, abort.signal).then(
      (review) => {
        if (abort.signal.aborted) return
        setState((latest) =>
          latest._tag === "ready" && sameReviewScope(latest, current) && matchesScope(review, current)
            ? { ...latest, review }
            : latest
        )
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedPullRequestReviewFailure(failure)) onSessionExpired(current.sessionKey)
      }
    )
  }, [onSessionExpired, state])

  const previewPublication = useCallback((selection: ReviewSuggestionPublicationTarget) => {
    if (
      state._tag !== "ready" ||
      state.review._tag !== "completed" ||
      state.review.jobId !== selection.jobId ||
      !state.review.report.suggestions.some(
        ({ suggestionId }) => suggestionId === selection.suggestionId
      )
    ) return
    const current = state
    mutationAbort.current?.abort()
    const abort = new AbortController()
    mutationAbort.current = abort
    setPublication({ _tag: "previewing", selection })
    transport.previewPublication(entityId, selection, abort.signal).then(
      (preview) => {
        if (abort.signal.aborted) return
        setPublication(
          preview.subject.headRevision === current.headRevision
            ? { _tag: "preview", preview }
            : { _tag: "failed", preview: null, selection }
        )
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedPullRequestReviewFailure(failure)) onSessionExpired(current.sessionKey)
        setPublication({ _tag: "failed", preview: null, selection })
      }
    )
  }, [entityId, onSessionExpired, state, transport])

  const publishSuggestion = useCallback((finalContent: ReviewSuggestionPublicationContent) => {
    if (state._tag !== "ready") return
    const preview = publication._tag === "preview"
      ? publication.preview
      : publication._tag === "failed"
      ? publication.preview
      : null
    if (preview === null) return
    const current = state
    const selection = {
      jobId: preview.jobId,
      suggestionId: preview.suggestionId,
      revisionId: preview.revisionId
    }
    publicationAbort.current?.abort()
    const abort = new AbortController()
    publicationAbort.current = abort
    setPublication({ _tag: "publishing", preview })
    transport.publishSuggestion(
      entityId,
      selection,
      finalContent,
      preview.authorityBinding,
      abort.signal
    ).then(
      (published) => {
        if (abort.signal.aborted) return
        const receiptMatches = published.suggestionRevision.reviewedHead ===
          preview.suggestionRevision.reviewedHead
        if (receiptMatches) {
          setState((latest) =>
            latest._tag === "ready" && latest.review._tag === "completed" &&
              latest.review.jobId === published.jobId
              ? {
                ...latest,
                review: {
                  ...latest.review,
                  report: {
                    ...latest.review.report,
                    suggestions: latest.review.report.suggestions.map((suggestion) => {
                      if (suggestion.suggestionId !== published.suggestionId) return suggestion
                      const transitioned: typeof suggestion = { ...suggestion, state: "published" }
                      return transitioned
                    })
                  }
                }
              }
              : latest
          )
        }
        setPublication(
          receiptMatches
            ? {
              _tag: "published",
              headSuperseded: latestScope.current === null ||
                published.subject.baseRevision !== latestScope.current.baseRevision ||
                published.subject.headRevision !== latestScope.current.headRevision,
              preview,
              publication: published
            }
            : { _tag: "receipt-conflict", preview, publication: published }
        )
        const activeScope = latestScope.current
        if (
          activeScope !== null &&
          activeScope.entityId === current.entityId &&
          activeScope.sessionKey === current.sessionKey
        ) refreshThread(activeScope, abort.signal)
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedPullRequestReviewFailure(failure)) onSessionExpired(current.sessionKey)
        setPublication({ _tag: "failed", preview, selection })
      }
    )
  }, [entityId, onSessionExpired, publication, refreshThread, state, transport])

  const targetSuggestion = useCallback((target: ReviewSuggestionTarget) => {
    if (
      state._tag !== "ready" ||
      state.review._tag !== "completed" ||
      state.review.jobId !== target.jobId ||
      state.provider === null ||
      !state.review.report.suggestions.some(({ suggestionId }) => suggestionId === target.suggestionId)
    ) return
    if (transport.targetSuggestion === undefined) return
    const current = state
    mutationAbort.current?.abort()
    const abort = new AbortController()
    mutationAbort.current = abort
    setState({ ...current, action: "starting" })
    transport.targetSuggestion(entityId, target, state.provider, abort.signal).then(
      (review) => {
        if (abort.signal.aborted) return
        setState((latest) =>
          latest._tag === "ready" && sameReviewScope(latest, current) && matchesScope(review, current)
            ? { ...latest, action: "idle", review }
            : latest
        )
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedPullRequestReviewFailure(failure)) onSessionExpired(current.sessionKey)
        setState((latest) =>
          latest._tag === "ready" && sameReviewScope(latest, current)
            ? { ...latest, action: "failed" }
            : latest
        )
      }
    )
  }, [entityId, onSessionExpired, state, transport])

  const currentState: PullRequestReviewControllerState = scope === null
    ? { _tag: "idle" }
    : state._tag !== "idle" && sameReviewScope(state, scope)
    ? state
    : { _tag: "loading", ...scope }

  return {
    cancel: useCallback(() => {
      if (transport.cancel === undefined) return
      mutatePendingReview((jobId, signal) => transport.cancel!(entityId, jobId, signal))
    }, [entityId, mutatePendingReview, transport]),
    cancelPublication: useCallback(() => {
      mutationAbort.current?.abort()
      mutationAbort.current = null
      publicationAbort.current?.abort()
      publicationAbort.current = null
      setPublication({ _tag: "idle" })
    }, []),
    extendBudget: useCallback(() => {
      if (transport.extendBudget === undefined) return
      mutatePendingReview((jobId, signal) => transport.extendBudget!(entityId, jobId, signal))
    }, [entityId, mutatePendingReview, transport]),
    loadEarlier,
    previewPublication,
    publication,
    publishSuggestion,
    targetSuggestion,
    retry: useCallback(() => {
      automaticRetryScope.current = null
      setRequestRevision((revision) => revision + 1)
    }, []),
    start,
    state: currentState
  }
}
