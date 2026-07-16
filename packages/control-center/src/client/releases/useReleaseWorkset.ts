import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
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

export const MAXIMUM_RELEASE_WORKSET_REQUEST_CONCURRENCY = 4

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

/** Load every release/environment slice without saturating browser or server connection pools. */
export const loadReleaseWorksetInspections = async (
  releaseId: ReleaseId,
  environmentIds: ReadonlyArray<EnvironmentId>,
  signal: AbortSignal,
  transport: ReleaseWorksetTransport
): Promise<ReadonlyArray<ReleaseDeliveryGraphInspection>> => {
  const scopes: ReadonlyArray<EnvironmentId | null> = [null, ...environmentIds]
  const completed: Array<{ readonly index: number; readonly inspection: ReleaseDeliveryGraphInspection }> = []
  let nextIndex = 0
  let isStopped = false
  const loadNext = async (): Promise<void> => {
    while (!isStopped && nextIndex < scopes.length) {
      const index = nextIndex
      nextIndex += 1
      const environmentId = scopes[index]
      if (environmentId === undefined) return
      try {
        const inspection = await transport.load(releaseId, environmentId, signal)
        completed.push({ index, inspection })
      } catch (failure) {
        isStopped = true
        throw failure
      }
    }
  }
  const workerCount = Math.min(MAXIMUM_RELEASE_WORKSET_REQUEST_CONCURRENCY, scopes.length)
  await Promise.all(Array.from({ length: workerCount }, () => loadNext()))
  return completed.sort((left, right) => left.index - right.index).map(({ inspection }) => inspection)
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
  onSessionExpired: (sessionKey: string) => void,
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
    loadReleaseWorksetInspections(releaseId, environmentIds, abort.signal, transport).then(
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
      (failure) => {
        if (!abort.signal.aborted) {
          if (isUnauthorizedFailure(failure)) onSessionExpired(sessionKey)
          setState({ _tag: "failed", environmentScopeKey, releaseId, sessionKey })
        }
      }
    )
    return () => abort.abort()
  }, [environmentScopeKey, onSessionExpired, releaseId, requestRevision, sessionKey, transport])

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
