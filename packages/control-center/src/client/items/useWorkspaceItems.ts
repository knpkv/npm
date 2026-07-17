import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useMemo, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { WorkspaceEntityProjectionIndex } from "../../api/deliveryGraph.js"
import type {
  DeliveryEntityKind,
  DeliveryEntityService,
  DeliveryEntityStatusGroup
} from "../../domain/deliveryGraph.js"
import type { ReleaseId, WorkspaceId } from "../../domain/identifiers.js"
import { presentWorkspaceEntityIndex, type WorkspaceItemPresentation } from "./presentWorkspaceItems.js"

export type WorkspaceItemsState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading"; readonly scopeKey: string; readonly sessionKey: string }
  | { readonly _tag: "failed"; readonly scopeKey: string; readonly sessionKey: string }
  | {
    readonly _tag: "ready"
    readonly items: ReadonlyArray<WorkspaceItemPresentation>
    readonly matchedCount: number
    readonly refreshing: boolean
    readonly scopeKey: string
    readonly sessionKey: string
    readonly truncated: boolean
    readonly totalCount: number
  }

export interface WorkspaceItemsQuery {
  readonly query: string
  readonly service: DeliveryEntityService | "all"
  readonly status: DeliveryEntityStatusGroup | "all"
  readonly type: DeliveryEntityKind | "all"
}

export interface WorkspaceItemsTransport {
  readonly load: (signal: AbortSignal, query: WorkspaceItemsQuery) => Promise<WorkspaceEntityProjectionIndex>
}

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

/** Generated-client transport for the authenticated workspace entity index. */
export const browserWorkspaceItemsTransport: WorkspaceItemsTransport = {
  load: (signal, query) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.deliveryGraph.workspaceEntityProjections({
          query: {
            ...(query.query.length === 0 ? {} : { q: query.query }),
            ...(query.service === "all" ? {} : { service: query.service }),
            ...(query.status === "all" ? {} : { status: query.status }),
            ...(query.type === "all" ? {} : { type: query.type })
          }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

/** Keep one bounded workspace entity index scoped to the exact browser session. */
export const useWorkspaceItems = (
  workspaceId: WorkspaceId,
  routableReleaseIds: ReadonlySet<ReleaseId>,
  filters: WorkspaceItemsQuery,
  refreshKey: string,
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  transport: WorkspaceItemsTransport = browserWorkspaceItemsTransport
): { readonly retry: () => void; readonly state: WorkspaceItemsState } => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<WorkspaceItemsState>({ _tag: "idle" })
  const releaseScopeKey = [...routableReleaseIds].join(":")
  const query = useMemo<WorkspaceItemsQuery>(() => ({
    query: filters.query,
    service: filters.service,
    status: filters.status,
    type: filters.type
  }), [filters.query, filters.service, filters.status, filters.type])
  const filterScopeKey = `${query.query}|${query.service}|${query.status}|${query.type}`
  const scopeKey = `${workspaceId}|${releaseScopeKey}|${refreshKey}|${filterScopeKey}`

  useEffect(() => {
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const abort = new AbortController()
    setState((current) =>
      current._tag === "ready" && current.sessionKey === sessionKey
        ? current
        : { _tag: "loading", scopeKey, sessionKey }
    )
    transport.load(abort.signal, query).then(
      (index) => {
        if (abort.signal.aborted) return
        setState({
          _tag: "ready",
          items: presentWorkspaceEntityIndex(workspaceId, index, routableReleaseIds),
          matchedCount: index.matchedCount,
          refreshing: false,
          scopeKey,
          sessionKey,
          totalCount: index.totalCount,
          truncated: index.truncated
        })
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedFailure(failure)) onSessionExpired(sessionKey)
        setState({ _tag: "failed", scopeKey, sessionKey })
      }
    )
    return () => abort.abort()
  }, [onSessionExpired, query, requestRevision, routableReleaseIds, scopeKey, sessionKey, transport, workspaceId])

  const currentState: WorkspaceItemsState = sessionKey === null
    ? { _tag: "idle" }
    : state._tag === "idle" || state.sessionKey !== sessionKey
    ? { _tag: "loading", scopeKey, sessionKey }
    : state._tag === "ready" && state.scopeKey !== scopeKey
    ? { ...state, refreshing: true }
    : state._tag !== "ready" && state.scopeKey !== scopeKey
    ? { _tag: "loading", scopeKey, sessionKey }
    : state

  return {
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    state: currentState
  }
}
