import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { WorkspaceEntityInspection } from "../../api/deliveryGraph.js"
import type { EntityId, WorkspaceId } from "../../domain/identifiers.js"

interface WorkspaceEntityScope {
  readonly entityId: EntityId
  readonly refreshKey: string
  readonly sessionKey: string
  readonly workspaceId: WorkspaceId
}

export type WorkspaceEntityStaleReason = "refresh-failed" | "refreshing" | "source-stale"

/** Complete controller state for one exact canonical workspace entity read. */
export type WorkspaceEntityState =
  | { readonly _tag: "idle" }
  | ({ readonly _tag: "loading" } & WorkspaceEntityScope)
  | ({ readonly _tag: "not-found" } & WorkspaceEntityScope)
  | ({ readonly _tag: "failed" } & WorkspaceEntityScope)
  | ({ readonly _tag: "ready"; readonly inspection: WorkspaceEntityInspection } & WorkspaceEntityScope)
  | ({
    readonly _tag: "stale"
    readonly inspection: WorkspaceEntityInspection
    readonly reason: WorkspaceEntityStaleReason
  } & WorkspaceEntityScope)

/** Browser boundary for one exact authenticated workspace entity read. */
export interface WorkspaceEntityTransport {
  readonly load: (entityId: EntityId, signal: AbortSignal) => Promise<WorkspaceEntityInspection>
}

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")
const isNotFoundFailure = Predicate.isTagged("NotFoundApiError")

const sameIdentity = (state: WorkspaceEntityState, scope: WorkspaceEntityScope): boolean =>
  state._tag !== "idle" &&
  state.entityId === scope.entityId &&
  state.sessionKey === scope.sessionKey &&
  state.workspaceId === scope.workspaceId

const retainedInspection = (
  state: WorkspaceEntityState,
  scope: WorkspaceEntityScope
): WorkspaceEntityInspection | null =>
  sameIdentity(state, scope) && (state._tag === "ready" || state._tag === "stale")
    ? state.inspection
    : null

const successfulState = (
  inspection: WorkspaceEntityInspection,
  scope: WorkspaceEntityScope
): WorkspaceEntityState =>
  !inspection.isSourceCurrent || inspection.freshness?._tag === "stale"
    ? { _tag: "stale", inspection, reason: "source-stale", ...scope }
    : { _tag: "ready", inspection, ...scope }

/** Generated-client transport for the canonical schema-decoded entity inspection. */
export const browserWorkspaceEntityTransport: WorkspaceEntityTransport = {
  load: (entityId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.deliveryGraph.workspaceEntity({ params: { entityId } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

/** Keep one entity inspection scoped to the exact workspace, identity, refresh, and browser session. */
export const useWorkspaceEntity = (
  workspaceId: WorkspaceId,
  entityId: EntityId,
  refreshKey: string,
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  transport: WorkspaceEntityTransport = browserWorkspaceEntityTransport
): { readonly retry: () => void; readonly state: WorkspaceEntityState } => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<WorkspaceEntityState>({ _tag: "idle" })

  useEffect(() => {
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const scope = { entityId, refreshKey, sessionKey, workspaceId } satisfies WorkspaceEntityScope
    const abort = new AbortController()
    setState((current) => {
      const inspection = retainedInspection(current, scope)
      return inspection === null
        ? { _tag: "loading", ...scope }
        : { _tag: "stale", inspection, reason: "refreshing", ...scope }
    })
    transport.load(entityId, abort.signal).then(
      (inspection) => {
        if (!abort.signal.aborted) setState(successfulState(inspection, scope))
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (isUnauthorizedFailure(failure)) {
          onSessionExpired(sessionKey)
          setState({ _tag: "failed", ...scope })
          return
        }
        if (isNotFoundFailure(failure)) {
          setState({ _tag: "not-found", ...scope })
          return
        }
        setState((current) => {
          const inspection = retainedInspection(current, scope)
          return inspection === null
            ? { _tag: "failed", ...scope }
            : { _tag: "stale", inspection, reason: "refresh-failed", ...scope }
        })
      }
    )
    return () => abort.abort()
  }, [entityId, onSessionExpired, refreshKey, requestRevision, sessionKey, transport, workspaceId])

  const scope = sessionKey === null
    ? null
    : { entityId, refreshKey, sessionKey, workspaceId } satisfies WorkspaceEntityScope
  const currentState: WorkspaceEntityState = scope === null
    ? { _tag: "idle" }
    : state._tag === "idle" || !sameIdentity(state, scope)
    ? { _tag: "loading", ...scope }
    : state.refreshKey !== refreshKey && (state._tag === "ready" || state._tag === "stale")
    ? { _tag: "stale", inspection: state.inspection, reason: "refreshing", ...scope }
    : state.refreshKey !== refreshKey
    ? { _tag: "loading", ...scope }
    : state

  return {
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    state: currentState
  }
}
