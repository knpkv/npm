import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type {
  EditReviewSuggestionRequest,
  EditReviewSuggestionResponse,
  ReviewSuggestionRevisionPage
} from "../../api/agent.js"
import { makeControlCenterApiClient } from "../../api/client.js"
import type { EntityId, JobId } from "../../domain/identifiers.js"
import type { PrReviewSuggestionId } from "../../domain/prReview.js"
import {
  type PrReviewSuggestionEdit,
  PrReviewSuggestionRevisionPageSize,
  type PrReviewSuggestionRevisionSequence
} from "../../domain/prReviewRevision.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

const REVISION_PAGE_SIZE = PrReviewSuggestionRevisionPageSize.make(24)

export interface ReviewSuggestionRevisionScope {
  readonly entityId: EntityId
  readonly jobId: JobId
  readonly sessionKey: string
  readonly suggestionId: PrReviewSuggestionId
}

export interface ReviewSuggestionRevisionTransport {
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

export type ReviewSuggestionRevisionState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly page: ReviewSuggestionRevisionPage }
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

const conflictFailure = Predicate.isTagged("ConflictApiError")

/** Scope-safe browser controller for one stable suggestion's immutable revisions. */
export const useReviewSuggestionRevisions = (
  scope: ReviewSuggestionRevisionScope | null,
  transport: ReviewSuggestionRevisionTransport = browserReviewSuggestionRevisionTransport
): {
  readonly loadEarlier: () => void
  readonly retry: () => void
  readonly save: (draft: PrReviewSuggestionEdit) => void
  readonly state: ReviewSuggestionRevisionState
} => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<ReviewSuggestionRevisionState>({ _tag: "idle" })
  const activeAbort = useRef<AbortController | null>(null)
  const latestScope = useRef(scope)
  latestScope.current = scope

  useEffect(() => {
    activeAbort.current?.abort()
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
    if (scope === null) return
    const retained = state._tag === "ready" || state._tag === "conflict"
      ? state.page
      : state._tag === "failed"
      ? state.page
      : null
    if (retained === null) return
    const current = scope
    activeAbort.current?.abort()
    const abort = new AbortController()
    activeAbort.current = abort
    setState({ _tag: "saving", draft, page: retained })
    transport.edit(current, {
      expectedRevisionId: retained.current.revisionId,
      expectedSequence: retained.current.sequence,
      edit: draft
    }, abort.signal).then(
      () => transport.load(current, null, abort.signal),
      (failure: unknown) => {
        if (!conflictFailure(failure)) throw failure
        return transport.load(current, null, abort.signal).then((page) => {
          if (
            abort.signal.aborted ||
            latestScope.current === null ||
            !sameScope(latestScope.current, current)
          ) return page
          setState({ _tag: "conflict", draft, page })
          return page
        })
      }
    ).then(
      (page) => {
        if (
          abort.signal.aborted ||
          latestScope.current === null ||
          !sameScope(latestScope.current, current)
        ) return
        setState((latest) =>
          latest._tag === "conflict"
            ? latest
            : { _tag: "ready", page }
        )
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

  const loadEarlier = useCallback((): void => {
    if (
      scope === null ||
      (state._tag !== "ready" && state._tag !== "conflict") ||
      !state.page.hasMore ||
      state.page.nextBeforeSequence === null
    ) return
    const current = scope
    const retained = state.page
    const retainedDraft = state._tag === "conflict" ? state.draft : null
    const abort = new AbortController()
    activeAbort.current = abort
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
        const merged = mergePages(retained, page)
        setState(
          retainedDraft === null
            ? { _tag: "ready", page: merged }
            : { _tag: "conflict", draft: retainedDraft, page: merged }
        )
      },
      () => {
        if (
          abort.signal.aborted ||
          latestScope.current === null ||
          !sameScope(latestScope.current, current)
        ) return
        setState(
          retainedDraft === null
            ? { _tag: "failed", draft: null, page: retained }
            : { _tag: "conflict", draft: retainedDraft, page: retained }
        )
      }
    )
  }, [scope, state, transport])

  return useMemo(() => ({
    loadEarlier,
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
  }), [loadEarlier, save, state])
}
