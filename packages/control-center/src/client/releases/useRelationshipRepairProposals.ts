import { useCallback, useEffect, useRef, useState } from "react"

import type { RelationshipRepairProposalList } from "../../api/deliveryGraph.js"
import type { RelationshipRepairProposalId, ReleaseId } from "../../domain/identifiers.js"
import type {
  RelationshipRepairApplication,
  RelationshipRepairReviewDecision
} from "../../domain/relationshipRepair.js"
import { browserRelationshipRepairTransport, type RelationshipRepairTransport } from "./relationshipRepairTransport.js"

export type RelationshipRepairPanelState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | {
    readonly _tag: "ready"
    readonly actionFailure: RelationshipRepairProposalId | null
    readonly applications: ReadonlyMap<RelationshipRepairProposalId, RelationshipRepairApplication>
    readonly busyProposalId: RelationshipRepairProposalId | null
    readonly page: RelationshipRepairProposalList
    readonly releaseId: ReleaseId
    readonly sessionKey: string
  }

export interface RelationshipRepairProposalController {
  readonly apply: (proposalId: RelationshipRepairProposalId) => Promise<boolean>
  readonly retry: () => void
  readonly review: (
    proposalId: RelationshipRepairProposalId,
    decision: RelationshipRepairReviewDecision,
    rationale: string
  ) => Promise<boolean>
  readonly state: RelationshipRepairPanelState
}

/** Keep one release's proposal ledger current after explicit review and apply actions. */
export const useRelationshipRepairProposals = (
  releaseId: ReleaseId,
  sessionKey: string | null,
  transport: RelationshipRepairTransport = browserRelationshipRepairTransport
): RelationshipRepairProposalController => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<RelationshipRepairPanelState>({ _tag: "idle" })
  const actionAbort = useRef<AbortController | null>(null)
  const busyProposal = useRef<RelationshipRepairProposalId | null>(null)
  const stateRef = useRef(state)

  useEffect(() => {
    actionAbort.current?.abort()
    actionAbort.current = null
    busyProposal.current = null
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const abort = new AbortController()
    setState({ _tag: "loading" })
    transport.list(releaseId, abort.signal).then(
      (page) => {
        if (!abort.signal.aborted) {
          setState({
            _tag: "ready",
            actionFailure: null,
            applications: new Map(),
            busyProposalId: null,
            page,
            releaseId,
            sessionKey
          })
        }
      },
      () => {
        if (!abort.signal.aborted) setState({ _tag: "failed" })
      }
    )
    return () => abort.abort()
  }, [releaseId, requestRevision, sessionKey, transport])

  useEffect(() => () => actionAbort.current?.abort(), [])

  const currentState = state._tag === "ready" &&
      (state.releaseId !== releaseId || state.sessionKey !== sessionKey)
    ? { _tag: "loading" } satisfies RelationshipRepairPanelState
    : state
  stateRef.current = currentState

  const beginAction = useCallback((proposalId: RelationshipRepairProposalId): AbortController | null => {
    if (stateRef.current._tag !== "ready" || busyProposal.current !== null) return null
    const abort = new AbortController()
    busyProposal.current = proposalId
    actionAbort.current?.abort()
    actionAbort.current = abort
    setState((current) =>
      current._tag === "ready"
        ? { ...current, actionFailure: null, busyProposalId: proposalId }
        : current
    )
    return abort
  }, [])

  const finishAction = useCallback((abort: AbortController): boolean => {
    if (actionAbort.current !== abort) return false
    actionAbort.current = null
    busyProposal.current = null
    return true
  }, [])

  const review = useCallback(async (
    proposalId: RelationshipRepairProposalId,
    decision: RelationshipRepairReviewDecision,
    rationale: string
  ): Promise<boolean> => {
    const abort = beginAction(proposalId)
    if (abort === null) return false
    try {
      const proposal = await transport.review(proposalId, decision, rationale, abort.signal)
      if (!finishAction(abort) || abort.signal.aborted) return false
      setState((current) =>
        current._tag !== "ready" || abort.signal.aborted
          ? current
          : {
            ...current,
            busyProposalId: null,
            page: {
              ...current.page,
              proposals: current.page.proposals.map((item) => item.proposalId === proposalId ? proposal : item)
            }
          }
      )
      return true
    } catch {
      if (!abort.signal.aborted && finishAction(abort)) {
        setState((current) =>
          current._tag === "ready"
            ? { ...current, actionFailure: proposalId, busyProposalId: null }
            : current
        )
      }
      return false
    }
  }, [beginAction, finishAction, transport])

  const apply = useCallback(async (proposalId: RelationshipRepairProposalId): Promise<boolean> => {
    const abort = beginAction(proposalId)
    if (abort === null) return false
    try {
      const result = await transport.apply(proposalId, abort.signal)
      if (!finishAction(abort) || abort.signal.aborted) return false
      setState((current) => {
        if (current._tag !== "ready" || abort.signal.aborted) return current
        const applications = new Map(current.applications)
        applications.set(proposalId, result.application)
        return { ...current, applications, busyProposalId: null }
      })
      return true
    } catch {
      if (!abort.signal.aborted && finishAction(abort)) {
        setState((current) =>
          current._tag === "ready"
            ? { ...current, actionFailure: proposalId, busyProposalId: null }
            : current
        )
      }
      return false
    }
  }, [beginAction, finishAction, transport])

  return {
    apply,
    retry: useCallback(() => setRequestRevision((revision) => revision + 1), []),
    review,
    state: currentState
  }
}
