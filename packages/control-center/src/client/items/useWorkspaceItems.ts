import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { WorkspaceEntityProjectionIndex } from "../../api/deliveryGraph.js"
import type { ReleaseId, WorkspaceId } from "../../domain/identifiers.js"
import { presentWorkspaceEntityIndex, type WorkspaceItemPresentation } from "./presentWorkspaceItems.js"

export type WorkspaceItemsState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading"; readonly scopeKey: string; readonly sessionKey: string }
  | { readonly _tag: "failed"; readonly scopeKey: string; readonly sessionKey: string }
  | {
    readonly _tag: "ready"
    readonly items: ReadonlyArray<WorkspaceItemPresentation>
    readonly scopeKey: string
    readonly sessionKey: string
    readonly truncated: boolean
  }

export interface WorkspaceItemsTransport {
  readonly load: (signal: AbortSignal) => Promise<WorkspaceEntityProjectionIndex>
}

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

/** Generated-client transport for the authenticated workspace entity index. */
export const browserWorkspaceItemsTransport: WorkspaceItemsTransport = {
  load: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.deliveryGraph.workspaceEntityProjections({})
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

/** Keep one bounded workspace entity index scoped to the exact browser session. */
export const useWorkspaceItems = (
  workspaceId: WorkspaceId,
  routableReleaseIds: ReadonlySet<ReleaseId>,
  refreshKey: string,
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  transport: WorkspaceItemsTransport = browserWorkspaceItemsTransport
): { readonly retry: () => void; readonly state: WorkspaceItemsState } => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<WorkspaceItemsState>({ _tag: "idle" })
  const releaseScopeKey = [...routableReleaseIds].join(":")
  const scopeKey = `${workspaceId}|${releaseScopeKey}|${refreshKey}`

  useEffect(() => {
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const abort = new AbortController()
    setState({ _tag: "loading", scopeKey, sessionKey })
    transport.load(abort.signal).then(
      (index) => {
        if (abort.signal.aborted) return
        setState({
          _tag: "ready",
          items: presentWorkspaceEntityIndex(workspaceId, index, routableReleaseIds),
          scopeKey,
          sessionKey,
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
  }, [onSessionExpired, requestRevision, routableReleaseIds, scopeKey, sessionKey, transport, workspaceId])

  const currentState: WorkspaceItemsState = sessionKey === null
    ? { _tag: "idle" }
    : state._tag === "idle" || state.scopeKey !== scopeKey || state.sessionKey !== sessionKey
    ? { _tag: "loading", scopeKey, sessionKey }
    : state

  return {
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    state: currentState
  }
}
