import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type {
  DismissReviewSuggestionRequest,
  DismissReviewSuggestionResponse,
  EditReviewSuggestionRequest,
  EditReviewSuggestionResponse,
  ReviewSuggestionRevisionPage
} from "../../api/agent.js"
import { makeControlCenterApiClient } from "../../api/client.js"
import type { EntityId, JobId } from "../../domain/identifiers.js"
import type { PrReviewDismissalReason, PrReviewSuggestion, PrReviewSuggestionId } from "../../domain/prReview.js"
import {
  type PrReviewSuggestionEdit,
  PrReviewSuggestionRevisionPageSize,
  type PrReviewSuggestionRevisionSequence
} from "../../domain/prReviewRevision.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

type PrReviewDismissalReasonType = typeof PrReviewDismissalReason.Type

const REVISION_PAGE_SIZE = PrReviewSuggestionRevisionPageSize.make(24)

export interface ReviewSuggestionRevisionScope {
  readonly entityId: EntityId
  readonly jobId: JobId
  readonly sessionKey: string
  readonly suggestionId: PrReviewSuggestionId
}

export interface ReviewSuggestionRevisionTransport {
  readonly dismiss?: (
    scope: ReviewSuggestionRevisionScope,
    request: DismissReviewSuggestionRequest,
    signal: AbortSignal
  ) => Promise<DismissReviewSuggestionResponse>
  readonly edit: (
    scope: ReviewSuggestionRevisionScope,
    request: EditReviewSuggestionRequest,
    signal: AbortSignal
  ) => Promise<EditReviewSuggestionResponse>
  readonly load: (
    scope: ReviewSuggestionRevisionScope,
    before: PrReviewSuggestionRevisionSequence | null,
    signal: AbortSignal
  ) => Promise<ReviewSuggestionRevisionPage>
}

export type ReviewSuggestionRevisionAccepted = (suggestion: PrReviewSuggestion) => void

export type ReviewSuggestionRevisionState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly page: ReviewSuggestionRevisionPage }
  | { readonly _tag: "dismissing"; readonly page: ReviewSuggestionRevisionPage }
  | {
    readonly _tag: "saving"
    readonly draft: PrReviewSuggestionEdit
    readonly page: ReviewSuggestionRevisionPage
  }
  | {
    readonly _tag: "conflict"
    readonly draft: PrReviewSuggestionEdit
    readonly page: ReviewSuggestionRevisionPage
  }
  | {
    readonly _tag: "failed"
    readonly draft: PrReviewSuggestionEdit | null
    readonly page: ReviewSuggestionRevisionPage | null
  }

export const browserReviewSuggestionRevisionTransport: ReviewSuggestionRevisionTransport = {
  dismiss: (scope, request, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.agent.dismissReviewSuggestion({
          params: {
            entityId: scope.entityId,
            jobId: scope.jobId,
            suggestionId: scope.suggestionId
          },
          payload: request
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  edit: (scope, request, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.agent.editReviewSuggestion({
          params: {
            entityId: scope.entityId,
            jobId: scope.jobId,
            suggestionId: scope.suggestionId
          },
          payload: request
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  load: (scope, before, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.agent.reviewSuggestionRevisions({
          params: {
            entityId: scope.entityId,
            jobId: scope.jobId,
            suggestionId: scope.suggestionId
          },
          query: {
            ...(before === null ? {} : { before }),
            limit: REVISION_PAGE_SIZE
          }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

const sameScope = (
  left: ReviewSuggestionRevisionScope,
  right: ReviewSuggestionRevisionScope
): boolean =>
  left.entityId === right.entityId &&
  left.jobId === right.jobId &&
  left.sessionKey === right.sessionKey &&
  left.suggestionId === right.suggestionId

const mergePages = (
  retained: ReviewSuggestionRevisionPage,
  earlier: ReviewSuggestionRevisionPage
): ReviewSuggestionRevisionPage => {
  const current = earlier.current.sequence > retained.current.sequence
    ? earlier.current
    : retained.current
  const revisions = new Map(
    [
      retained.current,
      earlier.current,
      ...retained.revisions,
      ...earlier.revisions
    ]
      .filter(({ revisionId }) => revisionId !== current.revisionId)
      .map((revision) => [revision.revisionId, revision])
  )
  return {
    current,
    revisions: [...revisions.values()].sort(
      (left, right) => right.sequence - left.sequence
    ),
    hasMore: earlier.hasMore,
    nextBeforeSequence: earlier.nextBeforeSequence
  }
}

const pageWithAcceptedRevision = (
  retained: ReviewSuggestionRevisionPage,
  accepted: ReviewSuggestionRevisionPage["current"]
): ReviewSuggestionRevisionPage => ({
  current: accepted,
  revisions: [retained.current, ...retained.revisions]
    .filter(({ revisionId }) => revisionId !== accepted.revisionId)
    .sort((left, right) => right.sequence - left.sequence),
  hasMore: retained.hasMore,
  nextBeforeSequence: retained.nextBeforeSequence
})

type SaveOutcome =
  | { readonly _tag: "accepted-refresh-failed"; readonly page: ReviewSuggestionRevisionPage }
  | { readonly _tag: "conflict"; readonly page: ReviewSuggestionRevisionPage }
  | { readonly _tag: "refreshed"; readonly page: ReviewSuggestionRevisionPage }

const saveOutcome = (
  _tag: SaveOutcome["_tag"],
  page: ReviewSuggestionRevisionPage
): SaveOutcome => ({ _tag, page })

const conflictFailure = Predicate.isTagged("ConflictApiError")
const ignoreAcceptedRevision = (_suggestion: PrReviewSuggestion): void => undefined

/** Scope-safe browser controller for one stable suggestion's immutable revisions. */
export const useReviewSuggestionRevisions = (
  scope: ReviewSuggestionRevisionScope | null,
  transport: ReviewSuggestionRevisionTransport = browserReviewSuggestionRevisionTransport,
  onAccepted: ReviewSuggestionRevisionAccepted = ignoreAcceptedRevision
): {
  readonly dismiss: (reason: PrReviewDismissalReasonType) => void
  readonly loadEarlier: () => void
  readonly loadingEarlier: boolean
  readonly resolveConflict: () => void
  readonly retry: () => void
  readonly save: (draft: PrReviewSuggestionEdit) => void
  readonly state: ReviewSuggestionRevisionState
} => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [state, setState] = useState<ReviewSuggestionRevisionState>({ _tag: "idle" })
  const activeAbort = useRef<AbortController | null>(null)
  const loadingEarlierRef = useRef(false)
  const latestScope = useRef(scope)
  const latestOnAccepted = useRef(onAccepted)
  latestScope.current = scope
  latestOnAccepted.current = onAccepted

  useEffect(() => {
    activeAbort.current?.abort()
    loadingEarlierRef.current = false
    setLoadingEarlier(false)
    if (scope === null) {
      setState({ _tag: "idle" })
      return
    }
    const current = scope
    const abort = new AbortController()
    activeAbort.current = abort
    setState({ _tag: "loading" })
    transport.load(current, null, abort.signal).then(
      (page) => {
        if (
          abort.signal.aborted ||
          latestScope.current === null ||
          !sameScope(latestScope.current, current)
        ) return
        setState({ _tag: "ready", page })
      },
      () => {
        if (
          abort.signal.aborted ||
          latestScope.current === null ||
          !sameScope(latestScope.current, current)
        ) return
        setState({ _tag: "failed", draft: null, page: null })
      }
    )
    return () => abort.abort()
  }, [requestRevision, scope, transport])

  const save = useCallback((draft: PrReviewSuggestionEdit): void => {
    if (scope === null || state._tag === "conflict") return
    const retained = state._tag === "ready"
      ? state.page
      : state._tag === "failed"
      ? state.page
      : null
    if (retained === null) return
    const current = scope
    activeAbort.current?.abort()
    loadingEarlierRef.current = false
    setLoadingEarlier(false)
    const abort = new AbortController()
    activeAbort.current = abort
    setState({ _tag: "saving", draft, page: retained })
    transport.edit(current, {
      expectedRevisionId: retained.current.revisionId,
      expectedSequence: retained.current.sequence,
      edit: draft
    }, abort.signal).then(
      (accepted) => {
        const acceptedPage = pageWithAcceptedRevision(retained, accepted)
        return transport.load(current, null, abort.signal).then(
          (page) => saveOutcome("refreshed", page),
          () => saveOutcome("accepted-refresh-failed", acceptedPage)
        )
      },
      (failure: unknown) => {
        if (!conflictFailure(failure)) throw failure
        return transport.load(current, null, abort.signal).then((page) => {
          if (
            abort.signal.aborted ||
            latestScope.current === null ||
            !sameScope(latestScope.current, current)
          ) return saveOutcome("conflict", page)
          setState({ _tag: "conflict", draft, page })
          return saveOutcome("conflict", page)
        })
      }
    ).then(
      (outcome) => {
        if (
          abort.signal.aborted ||
          latestScope.current === null ||
          !sameScope(latestScope.current, current)
        ) return
        setState((latest) =>
          latest._tag === "conflict"
            ? latest
            : outcome._tag === "accepted-refresh-failed"
            ? { _tag: "failed", draft: null, page: outcome.page }
            : { _tag: "ready", page: outcome.page }
        )
        if (outcome._tag !== "conflict") latestOnAccepted.current(outcome.page.current.suggestion)
      },
      () => {
        if (
          abort.signal.aborted ||
          latestScope.current === null ||
          !sameScope(latestScope.current, current)
        ) return
        setState({ _tag: "failed", draft, page: retained })
      }
    )
  }, [scope, state, transport])

  const dismiss = useCallback((reason: PrReviewDismissalReasonType): void => {
    if (scope === null || state._tag !== "ready" || transport.dismiss === undefined) return
    const current = scope
    const retained = state.page
    activeAbort.current?.abort()
    loadingEarlierRef.current = false
    setLoadingEarlier(false)
    const abort = new AbortController()
    activeAbort.current = abort
    setState({ _tag: "dismissing", page: retained })
    transport.dismiss(current, {
      expectedRevisionId: retained.current.revisionId,
      expectedSequence: retained.current.sequence,
      reason
    }, abort.signal).then(
      (accepted) => {
        if (
          abort.signal.aborted ||
          latestScope.current === null ||
          !sameScope(latestScope.current, current)
        ) return
        setState({
          _tag: "ready",
          page: pageWithAcceptedRevision(retained, accepted)
        })
        latestOnAccepted.current(accepted.suggestion)
      },
      () => {
        if (
          abort.signal.aborted ||
          latestScope.current === null ||
          !sameScope(latestScope.current, current)
        ) return
        setState({ _tag: "failed", draft: null, page: retained })
      }
    )
  }, [scope, state, transport])

  const loadEarlier = useCallback((): void => {
    if (
      scope === null ||
      (state._tag !== "ready" && state._tag !== "conflict") ||
      loadingEarlierRef.current ||
      !state.page.hasMore ||
      state.page.nextBeforeSequence === null
    ) return
    const current = scope
    const retained = state.page
    activeAbort.current?.abort()
    const abort = new AbortController()
    activeAbort.current = abort
    loadingEarlierRef.current = true
    setLoadingEarlier(true)
    transport.load(
      current,
      retained.nextBeforeSequence,
      abort.signal
    ).then(
      (page) => {
        if (
          abort.signal.aborted ||
          latestScope.current === null ||
          !sameScope(latestScope.current, current)
        ) return
        if (activeAbort.current !== abort) return
        setState((latest) =>
          latest._tag === "ready" || latest._tag === "conflict"
            ? { ...latest, page: mergePages(latest.page, page) }
            : latest
        )
        loadingEarlierRef.current = false
        setLoadingEarlier(false)
      },
      () => {
        if (
          abort.signal.aborted ||
          latestScope.current === null ||
          !sameScope(latestScope.current, current)
        ) return
        if (activeAbort.current !== abort) return
        setState((latest) =>
          latest._tag === "ready"
            ? { _tag: "failed", draft: null, page: latest.page }
            : latest
        )
        loadingEarlierRef.current = false
        setLoadingEarlier(false)
      }
    )
  }, [scope, state, transport])

  return useMemo(() => ({
    dismiss,
    loadEarlier,
    loadingEarlier,
    resolveConflict: () =>
      setState((latest) =>
        latest._tag === "conflict"
          ? { _tag: "ready", page: latest.page }
          : latest
      ),
    retry: () => {
      if (state._tag === "conflict") return
      if (
        state._tag === "failed" &&
        state.draft !== null &&
        state.page !== null
      ) {
        save(state.draft)
        return
      }
      setRequestRevision((revision) => revision + 1)
    },
    save,
    state
  }), [dismiss, loadEarlier, loadingEarlier, save, state])
}
