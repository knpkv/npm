import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import type { EnvironmentId, ReleaseId } from "../../domain/identifiers.js"

const distinct = <Value>(values: ReadonlyArray<Value>, key: (value: Value) => string): ReadonlyArray<Value> => {
  const seen = new Set<string>()
  const unique: Array<Value> = []
  for (const value of values) {
    const identity = key(value)
    if (seen.has(identity)) continue
    seen.add(identity)
    unique.push(value)
  }
  return unique
}

/** Combine release and environment slices without duplicating shared graph material. */
export const aggregateReleaseWorksetInspections = (
  releaseId: ReleaseId,
  inspections: ReadonlyArray<ReleaseDeliveryGraphInspection>
): ReleaseDeliveryGraphInspection => {
  const nodes = distinct(inspections.flatMap(({ nodes }) => nodes), ({ nodeId }) => nodeId)
  const entityProjections = distinct(
    inspections.flatMap(({ entityProjections }) => entityProjections),
    ({ projection }) => projection.entityId
  )
  const relationships = distinct(
    inspections.flatMap(({ relationships }) => relationships),
    ({ relationshipId, revision }) => `${relationshipId}:${revision}`
  )
  const evidenceClaims = distinct(
    inspections.flatMap(({ evidenceClaims }) => evidenceClaims),
    ({ evidenceClaimId }) => evidenceClaimId
  )
  const evidenceItems = distinct(
    inspections.flatMap(({ evidenceItems }) => evidenceItems),
    ({ evidenceId }) => evidenceId
  )
  return {
    releaseId,
    environmentId: null,
    truncated: inspections.some(({ truncated }) => truncated),
    nodes,
    entityProjections,
    relationships,
    evidenceClaims,
    evidenceItems
  }
}

export interface ReleaseWorksetTransport {
  readonly load: (
    releaseId: ReleaseId,
    environmentId: EnvironmentId | null,
    signal: AbortSignal
  ) => Promise<ReleaseDeliveryGraphInspection>
}

export type ReleaseWorksetState =
  | { readonly _tag: "idle" }
  | {
    readonly _tag: "loading"
    readonly environmentScopeKey: string
    readonly releaseId: ReleaseId
    readonly sessionKey: string
  }
  | {
    readonly _tag: "failed"
    readonly environmentScopeKey: string
    readonly releaseId: ReleaseId
    readonly sessionKey: string
  }
  | {
    readonly _tag: "ready"
    readonly inspection: ReleaseDeliveryGraphInspection
    readonly environmentScopeKey: string
    readonly releaseId: ReleaseId
    readonly sessionKey: string
  }

/** Generated-client transport for one authenticated bounded release graph. */
export const browserReleaseWorksetTransport: ReleaseWorksetTransport = {
  load: (releaseId, environmentId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.deliveryGraph.releaseSlice({
          params: { releaseId },
          query: environmentId === null ? {} : { environmentId }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

/** Keep one release workset scoped to the exact authenticated browser session. */
export const useReleaseWorkset = (
  releaseId: ReleaseId,
  environmentIds: ReadonlyArray<EnvironmentId>,
  sessionKey: string | null,
  transport: ReleaseWorksetTransport = browserReleaseWorksetTransport
): { readonly retry: () => void; readonly state: ReleaseWorksetState } => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<ReleaseWorksetState>({ _tag: "idle" })
  const environmentScopeKey = environmentIds.join(":")

  useEffect(() => {
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const abort = new AbortController()
    setState({ _tag: "loading", environmentScopeKey, releaseId, sessionKey })
    const scopes: ReadonlyArray<EnvironmentId | null> = [null, ...environmentIds]
    Promise.all(scopes.map((environmentId) => transport.load(releaseId, environmentId, abort.signal))).then(
      (inspections) => {
        if (!abort.signal.aborted) {
          setState({
            _tag: "ready",
            environmentScopeKey,
            inspection: aggregateReleaseWorksetInspections(releaseId, inspections),
            releaseId,
            sessionKey
          })
        }
      },
      () => {
        if (!abort.signal.aborted) setState({ _tag: "failed", environmentScopeKey, releaseId, sessionKey })
      }
    )
    return () => abort.abort()
  }, [environmentScopeKey, releaseId, requestRevision, sessionKey, transport])

  const currentState: ReleaseWorksetState = sessionKey === null
    ? { _tag: "idle" }
    : state._tag === "idle" ||
        state.releaseId !== releaseId ||
        state.sessionKey !== sessionKey ||
        state.environmentScopeKey !== environmentScopeKey
    ? { _tag: "loading", environmentScopeKey, releaseId, sessionKey }
    : state

  return {
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    state: currentState
  }
}
