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

/** Combine release and environment slices while retaining complete relationship closure. */
export const aggregateReleaseWorksetInspections = (
  releaseId: ReleaseId,
  inspections: ReadonlyArray<ReleaseDeliveryGraphInspection>
): ReleaseDeliveryGraphInspection => {
  type Inspection = ReleaseDeliveryGraphInspection
  const availableNodes = new Map<string, Inspection["nodes"][number]>()
  const availableProjections = new Map<string, Inspection["entityProjections"][number]>()
  const availableClaims = new Map<string, Inspection["evidenceClaims"][number]>()
  const availableEvidence = new Map<string, Inspection["evidenceItems"][number]>()
  for (const inspection of inspections) {
    for (const node of inspection.nodes) availableNodes.set(node.nodeId, node)
    for (const entry of inspection.entityProjections) {
      availableProjections.set(entry.projection.entityId, entry)
    }
    for (const claim of inspection.evidenceClaims) availableClaims.set(claim.evidenceClaimId, claim)
    for (const item of inspection.evidenceItems) availableEvidence.set(item.evidenceId, item)
  }
  const nodes = new Map<string, Inspection["nodes"][number]>()
  const entityProjections = new Map<string, Inspection["entityProjections"][number]>()
  const relationships = new Map<string, Inspection["relationships"][number]>()
  const evidenceClaims = new Map<string, Inspection["evidenceClaims"][number]>()
  const evidenceItems = new Map<string, Inspection["evidenceItems"][number]>()
  let truncated = inspections.some((inspection) => inspection.truncated)

  for (const relationship of inspections.flatMap(({ relationships }) => relationships)) {
    const relationshipKey = `${relationship.relationshipId}:${String(relationship.revision)}`
    if (relationships.has(relationshipKey)) continue
    const requiredNodes = [
      availableNodes.get(relationship.sourceNodeId),
      availableNodes.get(relationship.targetNodeId)
    ]
    if (requiredNodes.some((node) => node === undefined)) {
      truncated = true
      continue
    }
    const presentNodes = requiredNodes.filter((node) => node !== undefined)
    const entityNodes = presentNodes.filter(
      (node) => node.resolution._tag === "resolved" && node.resolution.target._tag === "entity"
    )
    const requiredProjections = entityNodes.flatMap((node) => {
      if (node.resolution._tag !== "resolved" || node.resolution.target._tag !== "entity") return []
      const projection = availableProjections.get(node.resolution.target.entityId)
      return projection === undefined ? [] : [projection]
    })
    const requiredClaims = relationship.evidenceClaimIds.flatMap((claimId) => {
      const claim = availableClaims.get(claimId)
      return claim === undefined ? [] : [claim]
    })
    const evidenceIds = new Set(requiredClaims.map(({ evidenceId }) => evidenceId))
    const requiredEvidence = [...evidenceIds].flatMap((evidenceId) => {
      const evidence = availableEvidence.get(evidenceId)
      return evidence === undefined ? [] : [evidence]
    })
    const closureMissing = requiredProjections.length !== entityNodes.length ||
      requiredClaims.length !== relationship.evidenceClaimIds.length ||
      requiredEvidence.length !== evidenceIds.size
    const newNodeCount = presentNodes.filter(({ nodeId }) => !nodes.has(nodeId)).length
    const newProjectionCount = requiredProjections.filter(({ projection }) =>
      !entityProjections.has(projection.entityId)
    ).length
    const newClaimCount = requiredClaims.filter(({ evidenceClaimId }) => !evidenceClaims.has(evidenceClaimId)).length
    const newEvidenceCount = requiredEvidence.filter(({ evidenceId }) => !evidenceItems.has(evidenceId)).length
    const closureExceedsBound = relationships.size === MAXIMUM_AGGREGATED_RELEASE_WORKSET_RECORDS ||
      nodes.size + newNodeCount > MAXIMUM_AGGREGATED_RELEASE_WORKSET_RECORDS ||
      entityProjections.size + newProjectionCount > MAXIMUM_AGGREGATED_RELEASE_WORKSET_RECORDS ||
      evidenceClaims.size + newClaimCount > MAXIMUM_AGGREGATED_RELEASE_WORKSET_RECORDS ||
      evidenceItems.size + newEvidenceCount > MAXIMUM_AGGREGATED_RELEASE_WORKSET_RECORDS
    if (closureMissing || closureExceedsBound) {
      truncated = true
      continue
    }
    relationships.set(relationshipKey, relationship)
    for (const node of presentNodes) nodes.set(node.nodeId, node)
    for (const entry of requiredProjections) entityProjections.set(entry.projection.entityId, entry)
    for (const claim of requiredClaims) evidenceClaims.set(claim.evidenceClaimId, claim)
    for (const item of requiredEvidence) evidenceItems.set(item.evidenceId, item)
  }
  return {
    releaseId,
    environmentId: null,
    truncated,
    nodes: [...nodes.values()],
    entityProjections: [...entityProjections.values()],
    relationships: [...relationships.values()],
    evidenceClaims: [...evidenceClaims.values()],
    evidenceItems: [...evidenceItems.values()]
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
