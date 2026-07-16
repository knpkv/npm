import { Button, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react"

import type {
  RelationshipRepairCandidate,
  RelationshipRepairCandidates,
  RelationshipRepairProposalDraft
} from "../../api/deliveryGraph.js"
import type { SessionSummary } from "../../api/session.js"
import type { RelationshipRepairProposalId, ReleaseId } from "../../domain/identifiers.js"
import {
  browserRelationshipRepairCandidateTransport,
  type RelationshipRepairCandidateTransport
} from "./relationshipRepairCandidateTransport.js"
import styles from "./RelationshipRepairCandidatePicker.module.css"

type PickerState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "load-failed" }
  | { readonly _tag: "ready"; readonly page: RelationshipRepairCandidates }
  | { readonly _tag: "drafting"; readonly page: RelationshipRepairCandidates }
  | {
      readonly _tag: "draft-failed"
      readonly candidate: RelationshipRepairCandidate
      readonly page: RelationshipRepairCandidates
    }
  | {
      readonly _tag: "draft"
      readonly draft: RelationshipRepairProposalDraft
      readonly page: RelationshipRepairCandidates
    }
  | {
      readonly _tag: "creating"
      readonly draft: RelationshipRepairProposalDraft
      readonly page: RelationshipRepairCandidates
      readonly proposalId: RelationshipRepairProposalId | null
    }
  | {
      readonly _tag: "create-failed"
      readonly draft: RelationshipRepairProposalDraft
      readonly page: RelationshipRepairCandidates
      readonly proposalId: RelationshipRepairProposalId | null
    }
  | { readonly _tag: "created" }

const titleCase = (value: string): string => value.replaceAll("-", " ")

const candidateTitle = (candidate: RelationshipRepairCandidate): string =>
  `${titleCase(candidate.relationship.sourceNodeKind)} → ${titleCase(candidate.relationship.targetNodeKind)}`

const PickerResult = ({
  announce = false,
  children,
  stateTag
}: {
  readonly announce?: boolean
  readonly children: ReactNode
  readonly stateTag: PickerState["_tag"]
}): ReactElement => {
  const result = useRef<HTMLDivElement>(null)
  useEffect(() => result.current?.focus(), [stateTag])
  return (
    <div aria-live={announce ? "polite" : undefined} ref={result} role={announce ? "status" : undefined} tabIndex={-1}>
      {children}
    </div>
  )
}

interface RelationshipRepairCandidatePickerProps {
  readonly onCreated: () => void
  readonly releaseId: ReleaseId
  readonly session: SessionSummary
  readonly transport?: RelationshipRepairCandidateTransport
}

/** Discover one incomplete relationship, preview its immutable draft, then create a governed proposal. */
export const RelationshipRepairCandidatePicker = ({
  onCreated,
  releaseId,
  session,
  transport = browserRelationshipRepairCandidateTransport
}: RelationshipRepairCandidatePickerProps): ReactElement | null => {
  const [state, setState] = useState<PickerState>({ _tag: "idle" })
  const request = useRef<AbortController | null>(null)
  const actorId = session.actor._tag === "human" ? session.actor.personId : session.actor.agentId
  const authorityScope = `${session.sessionId}:${session.workspaceId}:${session.permission}:${session.actor._tag}:${actorId}`

  useEffect(() => {
    request.current?.abort()
    request.current = null
    setState({ _tag: "idle" })
    return () => request.current?.abort()
  }, [authorityScope, releaseId])

  if (session.permission !== "workspace-owner") return null

  const run = async <Value,>(
    effect: (signal: AbortSignal) => Promise<Value>,
    onSuccess: (value: Value) => void,
    onFailure: () => void
  ): Promise<void> => {
    request.current?.abort()
    const abort = new AbortController()
    request.current = abort
    try {
      const value = await effect(abort.signal)
      if (!abort.signal.aborted && request.current === abort) onSuccess(value)
    } catch {
      if (!abort.signal.aborted && request.current === abort) onFailure()
    } finally {
      if (request.current === abort) request.current = null
    }
  }

  const discover = (): void => {
    setState({ _tag: "loading" })
    void run(
      (signal) => transport.list(releaseId, signal),
      (page) => setState({ _tag: "ready", page }),
      () => setState({ _tag: "load-failed" })
    )
  }

  const select = (candidate: RelationshipRepairCandidate, page: RelationshipRepairCandidates): void => {
    setState({ _tag: "drafting", page })
    void run(
      (signal) =>
        transport.draft(releaseId, candidate.relationship.relationshipId, candidate.relationship.revision, signal),
      (draft) => setState({ _tag: "draft", draft, page }),
      () => setState({ _tag: "draft-failed", candidate, page })
    )
  }

  const refreshCandidate = (staleCandidate: RelationshipRepairCandidate): void => {
    setState({ _tag: "loading" })
    void run(
      (signal) => transport.list(releaseId, signal),
      (page) => {
        const candidate = page.candidates.find(
          (item) => item.relationship.relationshipId === staleCandidate.relationship.relationshipId
        )
        if (candidate === undefined) {
          setState({ _tag: "ready", page })
          return
        }
        select(candidate, page)
      },
      () => setState({ _tag: "load-failed" })
    )
  }

  const create = (
    draft: RelationshipRepairProposalDraft,
    page: RelationshipRepairCandidates,
    pendingProposalId: RelationshipRepairProposalId | null = null
  ): void => {
    request.current?.abort()
    const abort = new AbortController()
    request.current = abort
    setState({ _tag: "creating", draft, page, proposalId: pendingProposalId })
    void (async () => {
      let proposalId = pendingProposalId
      try {
        proposalId ??= await transport.makeProposalId()
        if (abort.signal.aborted || request.current !== abort) return
        setState({ _tag: "creating", draft, page, proposalId })
        await transport.create(releaseId, draft, proposalId, abort.signal)
        if (abort.signal.aborted || request.current !== abort) return
        setState({ _tag: "created" })
        onCreated()
      } catch {
        if (!abort.signal.aborted && request.current === abort) {
          setState({ _tag: "create-failed", draft, page, proposalId })
        }
      } finally {
        if (request.current === abort) request.current = null
      }
    })()
  }

  if (state._tag === "idle") {
    return <Button onClick={discover}>Find repair candidates</Button>
  }
  if (state._tag === "loading") {
    return (
      <PickerResult announce stateTag={state._tag}>
        <Text tone="secondary">Finding incomplete relationships…</Text>
      </PickerResult>
    )
  }
  if (state._tag === "load-failed") {
    return (
      <PickerResult stateTag={state._tag}>
        <StatePanel
          action={<Button onClick={discover}>Try again</Button>}
          announce="assertive"
          description="Candidate discovery did not change the release."
          title="Could not find candidates"
          tone="caution"
        />
      </PickerResult>
    )
  }
  if (state._tag === "created") {
    return (
      <PickerResult announce stateTag={state._tag}>
        <StateLabel label="Proposal created" tone="positive" />
      </PickerResult>
    )
  }
  if (state._tag === "drafting") {
    return (
      <PickerResult announce stateTag={state._tag}>
        <Text tone="secondary">Preparing an exact proposal…</Text>
      </PickerResult>
    )
  }
  if (state._tag === "draft-failed") {
    return (
      <PickerResult stateTag={state._tag}>
        <StatePanel
          action={<Button onClick={() => refreshCandidate(state.candidate)}>Refresh candidate</Button>}
          announce="assertive"
          description="The relationship may have changed since discovery."
          title="Candidate is stale"
          tone="caution"
        />
      </PickerResult>
    )
  }
  if (state._tag === "draft" || state._tag === "creating" || state._tag === "create-failed") {
    const isCreating = state._tag === "creating"
    return (
      <PickerResult announce={isCreating} stateTag={state._tag}>
        <Surface as="section" className={styles.draft} padding="none" tone="secondary">
          <div className={styles.draftHeader}>
            <div>
              <Text as="h4" variant="card-title">
                {titleCase(state.draft.proposal.disposition)} relationship
              </Text>
              <Text tone="tertiary" variant="meta">
                r{state.draft.precondition.expectedRevision} → r{state.draft.precondition.expectedRevision + 1}
              </Text>
            </div>
            <StateLabel label="Proposal preview" size="compact" tone="neutral" />
          </div>
          <Text>{state.draft.proposal.rationale}</Text>
          {state._tag === "create-failed" ? (
            <Text role="alert" tone="secondary">
              The relationship changed or the proposal was not recorded. Refresh the candidate before retrying.
            </Text>
          ) : null}
          <div className={styles.actions}>
            <Button disabled={isCreating} onClick={() => setState({ _tag: "ready", page: state.page })} variant="quiet">
              Back
            </Button>
            <Button
              loading={isCreating}
              onClick={() => create(state.draft, state.page, state._tag === "create-failed" ? state.proposalId : null)}
              variant="primary"
            >
              Create proposal
            </Button>
          </div>
        </Surface>
      </PickerResult>
    )
  }

  if (state.page.candidates.length === 0) {
    return (
      <PickerResult announce stateTag={state._tag}>
        <Text tone="secondary">No incomplete relationships need an owner decision.</Text>
      </PickerResult>
    )
  }
  return (
    <PickerResult stateTag={state._tag}>
      <div className={styles.candidates}>
        <div className={styles.candidateHeader}>
          <Text tone="secondary">
            {state.page.candidates.length}
            {state.page.truncated ? "+" : ""} incomplete relationship
            {state.page.candidates.length === 1 ? "" : "s"}
          </Text>
          <Button onClick={() => setState({ _tag: "idle" })} variant="quiet">
            Close
          </Button>
        </div>
        {state.page.candidates.map((candidate) => (
          <button
            className={styles.candidate}
            key={candidate.relationship.relationshipId}
            onClick={() => select(candidate, state.page)}
            type="button"
          >
            <span>
              <strong>{candidateTitle(candidate)}</strong>
              <small>{candidate.explanation}</small>
            </span>
            <span aria-hidden="true">→</span>
          </button>
        ))}
      </div>
    </PickerResult>
  )
}
