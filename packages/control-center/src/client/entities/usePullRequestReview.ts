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
  ReviewSuggestionPublicationPreview,
  ReviewSuggestionPublicationSelection
} from "../../api/agent.js"
import type { EntityId } from "../../domain/identifiers.js"
import type { PullRequestReviewThread } from "./pullRequestReviewThreadReplay.js"

const pullRequestReviewBrowser = import("./pullRequestReviewThreadReplay.js")
const generatedClientTransport = pullRequestReviewBrowser.then(
  ({ generatedClientPullRequestReviewTransport }) => generatedClientPullRequestReviewTransport
)

interface ReviewProviderSelection {
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

export type PullRequestReviewControllerState =
  | { readonly _tag: "idle" }
  | ({ readonly _tag: "loading" } & PullRequestReviewScope)
  | ({ readonly _tag: "failed" } & PullRequestReviewScope)
  | ({
    readonly _tag: "ready"
    readonly action: "idle" | "starting" | "failed"
    readonly historyAction: "idle" | "loading" | "failed"
    readonly provider: ReviewProviderSelection | null
    readonly review: PullRequestReviewState
    readonly thread?: PullRequestReviewThread
  } & PullRequestReviewScope)

export type PullRequestReviewPublicationState =
  | { readonly _tag: "idle" }
  | {
    readonly _tag: "previewing"
    readonly selection: ReviewSuggestionPublicationSelection
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
    readonly selection: ReviewSuggestionPublicationSelection
  }

/** Browser boundary for immutable pull-request review reads and mutations. */
export interface PullRequestReviewTransport {
  readonly enqueue: (
    entityId: EntityId,
    provider: ReviewProviderSelection,
    prompt: DurableAgentPrompt | undefined,
    signal: AbortSignal
  ) => Promise<PullRequestReviewState>
  readonly load: (entityId: EntityId, signal: AbortSignal) => Promise<PullRequestReviewState>
  readonly loadThread: (
    entityId: EntityId,
    cursor: ReleaseAgentThreadCursor | null,
    signal: AbortSignal,
    direction?: "after" | "before"
  ) => Promise<PullRequestReviewThreadPage>
  readonly previewPublication: (
    entityId: EntityId,
    selection: ReviewSuggestionPublicationSelection,
    signal: AbortSignal
  ) => Promise<ReviewSuggestionPublicationPreview>
  readonly providers: (signal: AbortSignal) => Promise<AgentProviderCatalog>
  readonly publishSuggestion: (
    entityId: EntityId,
    selection: ReviewSuggestionPublicationSelection,
    finalContent: ReviewSuggestionPublicationContent,
    authorityBinding: ReviewSuggestionPublicationPreview["authorityBinding"],
    signal: AbortSignal
  ) => Promise<PublishedReviewComment>
}

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

const eligibleProvider = (catalog: AgentProviderCatalog): ReviewProviderSelection | null => {
  for (const provider of catalog.providers) {
    const model = provider.models[0]
    if (
      provider.health === "available" &&
      provider.capabilities.includes("pr-review") &&
      provider.reviewProfile !== undefined &&
      model
    ) {
      return { providerId: provider.providerId, model, reviewProfile: provider.reviewProfile }
    }
  }
  return null
}

/** Generated-client transport for the authenticated immutable-review contract. */
export const browserPullRequestReviewTransport: PullRequestReviewTransport = {
  enqueue: (...args) => generatedClientTransport.then((transport) => transport.enqueue(...args)),
  load: (...args) => generatedClientTransport.then((transport) => transport.load(...args)),
  loadThread: (...args) => generatedClientTransport.then((transport) => transport.loadThread(...args)),
  previewPublication: (...args) => generatedClientTransport.then((transport) => transport.previewPublication(...args)),
  providers: (...args) => generatedClientTransport.then((transport) => transport.providers(...args)),
  publishSuggestion: (...args) => generatedClientTransport.then((transport) => transport.publishSuggestion(...args))
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
  task.catch((failure: unknown) => {
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
): {
  readonly cancelPublication: () => void
  readonly loadEarlier: () => void
  readonly previewPublication: (selection: ReviewSuggestionPublicationSelection) => void
  readonly publication: PullRequestReviewPublicationState
  readonly publishSuggestion: (finalContent: ReviewSuggestionPublicationContent) => void
  readonly retry: () => void
  readonly start: (prompt?: DurableAgentPrompt) => void
  readonly state: PullRequestReviewControllerState
} => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<PullRequestReviewControllerState>({ _tag: "idle" })
  const [publication, setPublication] = useState<PullRequestReviewPublicationState>({ _tag: "idle" })
  const historyAbort = useRef<AbortController | null>(null)
  const mutationAbort = useRef<AbortController | null>(null)
  const publicationAbort = useRef<AbortController | null>(null)
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
    latestThread.current = null
  }, [scope])

  useEffect(() => {
    if (sessionKey === null || headRevision === null) {
      setState({ _tag: "idle" })
      return
    }
    const scope = { baseRevision, entityId, headRevision, sessionKey } satisfies PullRequestReviewScope
    const previousThread = latestThread.current ?? undefined
    const abort = new AbortController()
    setState({ _tag: "loading", ...scope })
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
      ({ catalog, review, thread }) => {
        if (!abort.signal.aborted) {
          setState(
            matchesScope(review, scope)
              ? {
                _tag: "ready",
                ...scope,
                action: "idle",
                historyAction: "idle",
                provider: eligibleProvider(catalog),
                review,
                thread
              }
              : { _tag: "failed", ...scope }
          )
        }
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedFailure(failure)) onSessionExpired(sessionKey)
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
      (_failure: unknown) => {
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

  const start = useCallback((prompt?: DurableAgentPrompt) => {
    if (state._tag !== "ready" || state.review._tag === "unavailable") return
    const provider = state.provider
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
        if (isUnauthorizedFailure(failure)) onSessionExpired(current.sessionKey)
        setState((latest) =>
          latest._tag === "ready" && sameReviewScope(latest, current)
            ? { ...latest, action: "failed" }
            : latest
        )
      }
    )
  }, [entityId, onSessionExpired, state, transport])

  const previewPublication = useCallback((selection: ReviewSuggestionPublicationSelection) => {
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
        if (isUnauthorizedFailure(failure)) onSessionExpired(current.sessionKey)
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
      suggestionId: preview.suggestionId
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
        if (isUnauthorizedFailure(failure)) onSessionExpired(current.sessionKey)
        setPublication({ _tag: "failed", preview, selection })
      }
    )
  }, [entityId, onSessionExpired, publication, refreshThread, state, transport])

  const currentState: PullRequestReviewControllerState = scope === null
    ? { _tag: "idle" }
    : state._tag !== "idle" && sameReviewScope(state, scope)
    ? state
    : { _tag: "loading", ...scope }

  return {
    cancelPublication: useCallback(() => {
      mutationAbort.current?.abort()
      mutationAbort.current = null
      publicationAbort.current?.abort()
      publicationAbort.current = null
      setPublication({ _tag: "idle" })
    }, []),
    loadEarlier,
    previewPublication,
    publication,
    publishSuggestion,
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    start,
    state: currentState
  }
}
