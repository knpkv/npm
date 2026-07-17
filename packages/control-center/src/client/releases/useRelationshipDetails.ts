import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useRef, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { EvidenceInspection, RelationshipHistoryInspection } from "../../api/deliveryGraph.js"
import type { EvidenceId, RelationshipId } from "../../domain/identifiers.js"

export const MAXIMUM_RELATIONSHIP_EVIDENCE_REQUEST_CONCURRENCY = 4

export interface RelationshipDetails {
  readonly evidence: ReadonlyArray<EvidenceInspection>
  readonly history: RelationshipHistoryInspection
}

export interface RelationshipDetailsTransport {
  readonly load: (
    relationshipId: RelationshipId,
    evidenceIds: ReadonlyArray<EvidenceId>,
    signal: AbortSignal
  ) => Promise<RelationshipDetails>
}

const isUnauthorizedFailure = Predicate.isTagged("UnauthorizedApiError")

/** Load one relationship ledger and only the immutable evidence it references. */
export const browserRelationshipDetailsTransport: RelationshipDetailsTransport = {
  load: (relationshipId, evidenceIds, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        const history = yield* client.deliveryGraph.relationshipHistory({ params: { relationshipId } })
        const evidence = yield* Effect.forEach(
          evidenceIds,
          (evidenceId) => client.deliveryGraph.evidence({ params: { evidenceId } }),
          { concurrency: MAXIMUM_RELATIONSHIP_EVIDENCE_REQUEST_CONCURRENCY }
        )
        return { evidence, history }
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

export type RelationshipDetailsState =
  | { readonly _tag: "idle" }
  | {
    readonly _tag: "loading"
    readonly evidenceKey: string
    readonly relationshipId: RelationshipId
    readonly sessionKey: string
  }
  | {
    readonly _tag: "failed"
    readonly evidenceKey: string
    readonly relationshipId: RelationshipId
    readonly sessionKey: string
  }
  | {
    readonly _tag: "ready"
    readonly details: RelationshipDetails
    readonly evidenceKey: string
    readonly relationshipId: RelationshipId
    readonly sessionKey: string
  }

/** Keep relationship details bound to the exact selection and authenticated browser session. */
export const useRelationshipDetails = (
  relationshipId: RelationshipId | null,
  evidenceIds: ReadonlyArray<EvidenceId>,
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  transport: RelationshipDetailsTransport = browserRelationshipDetailsTransport
): { readonly retry: () => void; readonly state: RelationshipDetailsState } => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<RelationshipDetailsState>({ _tag: "idle" })
  const evidenceKey = evidenceIds.join(":")
  const evidenceIdsRef = useRef(evidenceIds)

  useEffect(() => {
    evidenceIdsRef.current = evidenceIds
  }, [evidenceIds])

  useEffect(() => {
    if (relationshipId === null || sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const abort = new AbortController()
    setState({ _tag: "loading", evidenceKey, relationshipId, sessionKey })
    transport.load(relationshipId, evidenceIdsRef.current, abort.signal).then(
      (details) => {
        if (!abort.signal.aborted) setState({ _tag: "ready", details, evidenceKey, relationshipId, sessionKey })
      },
      (failure) => {
        if (!abort.signal.aborted) {
          if (isUnauthorizedFailure(failure)) onSessionExpired(sessionKey)
          setState({ _tag: "failed", evidenceKey, relationshipId, sessionKey })
        }
      }
    )
    return () => abort.abort()
  }, [evidenceKey, onSessionExpired, relationshipId, requestRevision, sessionKey, transport])

  const currentState: RelationshipDetailsState = relationshipId === null || sessionKey === null
    ? { _tag: "idle" }
    : state._tag === "idle" ||
        state.relationshipId !== relationshipId ||
        state.sessionKey !== sessionKey ||
        state.evidenceKey !== evidenceKey
    ? { _tag: "loading", evidenceKey, relationshipId, sessionKey }
    : state

  return {
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    state: currentState
  }
}
