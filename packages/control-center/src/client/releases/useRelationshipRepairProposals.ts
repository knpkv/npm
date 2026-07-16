import * as DateTime from "effect/DateTime"
import { useCallback, useEffect, useRef, useState } from "react"

import { MAXIMUM_REPAIR_PROPOSALS, type RelationshipRepairProposalList } from "../../api/deliveryGraph.js"
import type {
  EnvironmentId,
  RelationshipRepairProposalId,
  RelationshipRepairReviewId,
  ReleaseId
} from "../../domain/identifiers.js"
import type {
  RelationshipRepairApplication,
  RelationshipRepairProposal,
  RelationshipRepairReviewDecision
} from "../../domain/relationshipRepair.js"
import { loadReleaseEnvironmentSlices } from "./loadReleaseEnvironmentSlices.js"
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
    readonly environmentScopeKey: string
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

interface PendingReviewIntent {
  readonly decision: RelationshipRepairReviewDecision
  readonly rationale: string
  readonly reviewId: RelationshipRepairReviewId
}

const proposalOrder = (left: RelationshipRepairProposal, right: RelationshipRepairProposal): number => {
  const proposedAtOrder = DateTime.Order(right.proposedAt, left.proposedAt)
  return proposedAtOrder === 0 ? right.proposalId.localeCompare(left.proposalId) : proposedAtOrder
}

const aggregateProposalPages = (
  releaseId: ReleaseId,
  pages: ReadonlyArray<RelationshipRepairProposalList>
): RelationshipRepairProposalList => {
  const proposalsById = new Map<RelationshipRepairProposalId, RelationshipRepairProposal>()
  const applicationsByProposalId = new Map<RelationshipRepairProposalId, RelationshipRepairApplication>()
  for (const page of pages) {
    for (const proposal of page.proposals) proposalsById.set(proposal.proposalId, proposal)
    for (const application of page.applications) {
      applicationsByProposalId.set(application.proposalId, application)
    }
  }
  const orderedProposals = [...proposalsById.values()].sort(proposalOrder)
  const proposals = orderedProposals.slice(0, MAXIMUM_REPAIR_PROPOSALS)
  const applications = proposals.flatMap((proposal): ReadonlyArray<RelationshipRepairApplication> => {
    const application = applicationsByProposalId.get(proposal.proposalId)
    return application === undefined ? [] : [application]
  })
  return {
    releaseId,
    environmentId: null,
    status: null,
    truncated: pages.some(({ truncated }) => truncated) || orderedProposals.length > MAXIMUM_REPAIR_PROPOSALS,
    proposals,
    applications
  }
}

/** Keep one release's proposal ledger current after explicit review and apply actions. */
export const useRelationshipRepairProposals = (
  releaseId: ReleaseId,
  environmentIds: ReadonlyArray<EnvironmentId>,
  sessionKey: string | null,
  transport: RelationshipRepairTransport = browserRelationshipRepairTransport
): RelationshipRepairProposalController => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<RelationshipRepairPanelState>({ _tag: "idle" })
  const actionAbort = useRef<AbortController | null>(null)
  const busyProposal = useRef<RelationshipRepairProposalId | null>(null)
  const pendingReviews = useRef(new Map<RelationshipRepairProposalId, PendingReviewIntent>())
  const stateRef = useRef(state)
  const environmentScopeKey = environmentIds.join(":")

  useEffect(() => {
    actionAbort.current?.abort()
    actionAbort.current = null
    busyProposal.current = null
    pendingReviews.current.clear()
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }
    const abort = new AbortController()
    setState({ _tag: "loading" })
    loadReleaseEnvironmentSlices(
      environmentIds,
      (environmentId) => transport.list(releaseId, environmentId, abort.signal)
    ).then(
      (pages) => {
        if (!abort.signal.aborted) {
          const page = aggregateProposalPages(releaseId, pages)
          setState({
            _tag: "ready",
            actionFailure: null,
            applications: new Map(page.applications.map((application) => [application.proposalId, application])),
            busyProposalId: null,
            environmentScopeKey,
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
  }, [environmentScopeKey, releaseId, requestRevision, sessionKey, transport])

  useEffect(() => () => actionAbort.current?.abort(), [])

  const currentState = state._tag === "ready" &&
      (state.environmentScopeKey !== environmentScopeKey ||
        state.releaseId !== releaseId ||
        state.sessionKey !== sessionKey)
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
      const pending = pendingReviews.current.get(proposalId)
      const intent = pending?.decision === decision && pending.rationale === rationale
        ? pending
        : { decision, rationale, reviewId: await transport.makeReviewId() }
      pendingReviews.current.set(proposalId, intent)
      const proposal = await transport.review(proposalId, intent.reviewId, decision, rationale, abort.signal)
      if (!finishAction(abort) || abort.signal.aborted) return false
      pendingReviews.current.delete(proposalId)
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
