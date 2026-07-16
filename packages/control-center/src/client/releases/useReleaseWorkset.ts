import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import { MAXIMUM_RELEASE_SLICE_RECORDS, type ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import type { EnvironmentId, ReleaseId } from "../../domain/identifiers.js"
import {
  loadReleaseEnvironmentSlices,
  MAXIMUM_RELEASE_ENVIRONMENT_REQUEST_CONCURRENCY
} from "./loadReleaseEnvironmentSlices.js"

export const MAXIMUM_AGGREGATED_RELEASE_WORKSET_RECORDS = MAXIMUM_RELEASE_SLICE_RECORDS

interface BoundedDistinct<Value> {
  readonly truncated: boolean
  readonly values: ReadonlyArray<Value>
}

const boundedDistinct = <Source, Value>(
  sources: ReadonlyArray<Source>,
  values: (source: Source) => ReadonlyArray<Value>,
  key: (value: Value) => string
): BoundedDistinct<Value> => {
  const seen = new Set<string>()
  const unique: Array<Value> = []
  for (const source of sources) {
    for (const value of values(source)) {
      const identity = key(value)
      if (seen.has(identity)) continue
      if (unique.length === MAXIMUM_AGGREGATED_RELEASE_WORKSET_RECORDS) {
        return { truncated: true, values: unique }
      }
      seen.add(identity)
      unique.push(value)
    }
  }
  return { truncated: false, values: unique }
}

/** Combine release and environment slices without duplicating shared graph material. */
export const aggregateReleaseWorksetInspections = (
  releaseId: ReleaseId,
  inspections: ReadonlyArray<ReleaseDeliveryGraphInspection>
): ReleaseDeliveryGraphInspection => {
  const nodes = boundedDistinct(inspections, ({ nodes }) => nodes, ({ nodeId }) => nodeId)
  const entityProjections = boundedDistinct(
    inspections,
    ({ entityProjections }) => entityProjections,
    ({ projection }) => projection.entityId
  )
  const relationships = boundedDistinct(
    inspections,
    ({ relationships }) => relationships,
    ({ relationshipId, revision }) => `${relationshipId}:${revision}`
  )
  const evidenceClaims = boundedDistinct(
    inspections,
    ({ evidenceClaims }) => evidenceClaims,
    ({ evidenceClaimId }) => evidenceClaimId
  )
  const evidenceItems = boundedDistinct(
    inspections,
    ({ evidenceItems }) => evidenceItems,
    ({ evidenceId }) => evidenceId
  )
  return {
    releaseId,
    environmentId: null,
    truncated: inspections.some(({ truncated }) => truncated) ||
      nodes.truncated ||
      entityProjections.truncated ||
      relationships.truncated ||
      evidenceClaims.truncated ||
      evidenceItems.truncated,
    nodes: nodes.values,
    entityProjections: entityProjections.values,
    relationships: relationships.values,
    evidenceClaims: evidenceClaims.values,
    evidenceItems: evidenceItems.values
  }
}

export interface ReleaseWorksetTransport {
  readonly load: (
    releaseId: ReleaseId,
    environmentId: EnvironmentId | null,
    signal: AbortSignal
  ) => Promise<ReleaseDeliveryGraphInspection>
}

export const MAXIMUM_RELEASE_WORKSET_REQUEST_CONCURRENCY = MAXIMUM_RELEASE_ENVIRONMENT_REQUEST_CONCURRENCY

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

/** Load every release/environment slice without saturating browser or server connection pools. */
export const loadReleaseWorksetInspections = async (
  releaseId: ReleaseId,
  environmentIds: ReadonlyArray<EnvironmentId>,
  signal: AbortSignal,
  transport: ReleaseWorksetTransport
): Promise<ReadonlyArray<ReleaseDeliveryGraphInspection>> => {
  return loadReleaseEnvironmentSlices(
    environmentIds,
    (environmentId) => transport.load(releaseId, environmentId, signal)
  )
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
