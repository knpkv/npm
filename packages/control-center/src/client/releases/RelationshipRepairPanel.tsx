import { Person, type RlyPerson } from "@knpkv/rly/patterns"
import { Button, Field, Skeleton, StateLabel, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import { type ReactElement, useEffect, useRef, useState } from "react"

import type { SessionSummary } from "../../api/session.js"
import type { Actor } from "../../domain/actors.js"
import type {
  RelationshipRepairApplication,
  RelationshipRepairProposal,
  RelationshipRepairReviewDecision
} from "../../domain/relationshipRepair.js"
import type { RelationshipRepairProposalId } from "../../domain/identifiers.js"
import { useBrowserSession } from "../BrowserSession.js"
import type { PortfolioReleasePresentation } from "../portfolio/presentPortfolio.js"
import { type RelationshipRepairPanelState, useRelationshipRepairProposals } from "./useRelationshipRepairProposals.js"
import styles from "./RelationshipRepairPanel.module.css"

interface RelationshipRepairPanelViewProps {
  readonly onApply: (proposalId: RelationshipRepairProposalId) => Promise<boolean>
  readonly onRetry: () => void
  readonly onReview: (
    proposalId: RelationshipRepairProposalId,
    decision: RelationshipRepairReviewDecision,
    rationale: string
  ) => Promise<boolean>
  readonly release: PortfolioReleasePresentation
  readonly session: SessionSummary
  readonly state: RelationshipRepairPanelState
}

const shortId = (id: string): string => id.slice(-6)

const isSameActor = (left: Actor, right: Actor): boolean =>
  left._tag === right._tag &&
  (left._tag === "human"
    ? right._tag === "human" && left.personId === right.personId
    : right._tag === "agent" && left.agentId === right.agentId)

const actorPerson = (
  actor: Extract<Actor, { readonly _tag: "human" }>,
  release: PortfolioReleasePresentation,
  role: string
): RlyPerson => {
  const collaborator = release.collaborators.find(({ id }) => id.startsWith(`${actor.personId}:`))
  return collaborator === undefined
    ? { id: actor.personId, name: `Person ${shortId(actor.personId)}`, role }
    : { ...collaborator, role }
}

const ActorIdentity = ({
  actor,
  release,
  role
}: {
  readonly actor: Actor
  readonly release: PortfolioReleasePresentation
  readonly role: string
}): ReactElement =>
  actor._tag === "human" ? (
    <Person person={actorPerson(actor, release, role)} size="compact" />
  ) : (
    <div className={styles.agentIdentity}>
      <span aria-hidden="true" className={styles.agentGlyph}>
        ✦
      </span>
      <span>
        <strong>Agent {shortId(actor.agentId)}</strong>
        <small>{role}</small>
      </span>
    </div>
  )

const statusPresentation = (
  proposal: RelationshipRepairProposal,
  application: RelationshipRepairApplication | undefined
): { readonly label: string; readonly tone: "caution" | "critical" | "positive" } => {
  if (application !== undefined) return { label: `Applied · r${application.appliedRevision}`, tone: "positive" }
  switch (proposal.status) {
    case "pending":
      return { label: "Needs review", tone: "caution" }
    case "approved":
      return { label: "Ready to apply", tone: "positive" }
    case "rejected":
      return { label: "Rejected", tone: "critical" }
  }
}

const formattedTime = (timestamp: RelationshipRepairProposal["proposedAt"]): string =>
  DateTime.formatUtc(timestamp, {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    locale: "en-GB",
    minute: "2-digit",
    month: "short"
  })

interface ProposalRowProps {
  readonly actionFailed: boolean
  readonly application: RelationshipRepairApplication | undefined
  readonly isBusy: boolean
  readonly isGloballyBusy: boolean
  readonly onApply: RelationshipRepairPanelViewProps["onApply"]
  readonly onRetry: RelationshipRepairPanelViewProps["onRetry"]
  readonly onReview: RelationshipRepairPanelViewProps["onReview"]
  readonly proposal: RelationshipRepairProposal
  readonly release: PortfolioReleasePresentation
  readonly session: SessionSummary
}

const ProposalRow = ({
  actionFailed,
  application,
  isBusy,
  isGloballyBusy,
  onApply,
  onRetry,
  onReview,
  proposal,
  release,
  session
}: ProposalRowProps): ReactElement => {
  const [isReviewing, setIsReviewing] = useState(false)
  const [rationale, setRationale] = useState("")
  const [announcement, setAnnouncement] = useState<string | null>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const status = statusPresentation(proposal, application)
  const canReview =
    proposal.status === "pending" &&
    (session.permission === "workspace-owner" || session.permission === "workspace-approver") &&
    !isSameActor(proposal.origin.actor, session.actor)
  const canApply =
    proposal.status === "approved" && application === undefined && session.permission === "workspace-owner"
  const reviewRationale = rationale.trim()

  const review = async (decision: RelationshipRepairReviewDecision): Promise<void> => {
    if (reviewRationale.length === 0) return
    const recorded = await onReview(proposal.proposalId, decision, reviewRationale)
    if (!recorded) return
    setIsReviewing(false)
    setRationale("")
    setAnnouncement(decision === "approved" ? "Proposal approved." : "Proposal rejected.")
  }

  const apply = async (): Promise<void> => {
    const recorded = await onApply(proposal.proposalId)
    if (recorded) setAnnouncement("Repair applied.")
  }

  useEffect(() => {
    if (announcement !== null) statusRef.current?.focus()
  }, [announcement])

  return (
    <Surface as="article" className={styles.proposal} padding="none" tone="secondary">
      <header className={styles.proposalHeader}>
        <div className={styles.decision}>
          <strong>
            {proposal.disposition[0]?.toLocaleUpperCase("en-US")}
            {proposal.disposition.slice(1)}
          </strong>
          <code>
            r{proposal.expectedRevision} → r{proposal.expectedRevision + 1}
          </code>
        </div>
        <div className={styles.status} ref={statusRef} tabIndex={announcement === null ? undefined : -1}>
          <StateLabel label={status.label} size="compact" tone={status.tone} />
          <span aria-live="polite" className={styles.srOnly}>
            {announcement ?? ""}
          </span>
        </div>
      </header>

      <Text className={styles.rationale} variant="body-large">
        {proposal.rationale}
      </Text>

      <div className={styles.peopleTrace}>
        <ActorIdentity
          actor={proposal.origin.actor}
          release={release}
          role={`Proposed · ${formattedTime(proposal.proposedAt)}`}
        />
        {proposal.review === null ? null : (
          <>
            <span aria-hidden="true" className={styles.traceArrow}>
              →
            </span>
            <ActorIdentity
              actor={proposal.review.origin.actor}
              release={release}
              role={`${proposal.review.decision === "approved" ? "Approved" : "Rejected"} · ${formattedTime(proposal.review.reviewedAt)}`}
            />
          </>
        )}
        {application === undefined ? null : (
          <>
            <span aria-hidden="true" className={styles.traceArrow}>
              →
            </span>
            <ActorIdentity
              actor={application.origin.actor}
              release={release}
              role={`Applied revision ${application.appliedRevision} · ${formattedTime(application.appliedAt)}`}
            />
          </>
        )}
      </div>

      {actionFailed ? (
        <StatePanel
          action={<Button onClick={onRetry}>Reload decisions</Button>}
          announce="assertive"
          className={styles.actionFailure}
          description="The proposal may have changed. Reload the release decisions before trying again."
          title="Action not recorded"
          tone="caution"
        />
      ) : null}

      {isReviewing ? (
        <form className={styles.reviewForm} onSubmit={(event) => event.preventDefault()}>
          <Field description="Stored with the immutable decision." label="Review note" required>
            {(controlProps) => (
              <textarea
                {...controlProps}
                autoFocus
                maxLength={1_000}
                onChange={(event) => setRationale(event.currentTarget.value)}
                value={rationale}
              />
            )}
          </Field>
          <div className={styles.actions}>
            <Button
              disabled={reviewRationale.length === 0 || isGloballyBusy}
              loading={isBusy}
              onClick={() => void review("rejected")}
              variant="quiet"
            >
              Reject
            </Button>
            <Button
              disabled={reviewRationale.length === 0 || isGloballyBusy}
              loading={isBusy}
              onClick={() => void review("approved")}
              variant="primary"
            >
              Approve
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.actions}>
          {canReview ? (
            <Button disabled={isGloballyBusy} onClick={() => setIsReviewing(true)}>
              Review proposal
            </Button>
          ) : null}
          {canApply ? (
            <Button
              disabled={isGloballyBusy && !isBusy}
              loading={isBusy}
              onClick={() => void apply()}
              variant="primary"
            >
              Apply repair
            </Button>
          ) : null}
          {proposal.status === "pending" && isSameActor(proposal.origin.actor, session.actor) ? (
            <Text tone="tertiary" variant="meta">
              Another owner or approver must review.
            </Text>
          ) : null}
        </div>
      )}
    </Surface>
  )
}

const LoadingPanel = (): ReactElement => (
  <div aria-label="Loading release decisions" className={styles.loading} role="status">
    <Skeleton decorative={false} height="1.5rem" label="Loading release decisions" width="12rem" />
    <Skeleton decorative height="11rem" variant="block" />
  </div>
)

/** Render the exact, human-attributed decision ledger for one release. */
export const RelationshipRepairPanelView = ({
  onApply,
  onRetry,
  onReview,
  release,
  session,
  state
}: RelationshipRepairPanelViewProps): ReactElement => {
  if (state._tag === "idle" || state._tag === "loading") return <LoadingPanel />
  if (state._tag === "failed") {
    return (
      <StatePanel
        action={<Button onClick={onRetry}>Try again</Button>}
        description="Control Center could not read the governed decisions for this release."
        title="Release decisions unavailable"
        tone="caution"
      />
    )
  }
  if (state.page.proposals.length === 0) {
    return (
      <StatePanel
        description="No relationship repair is waiting for review or application."
        title="No repair decisions"
      />
    )
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <Text as="h3" variant="card-title">
            Repair decisions
          </Text>
          <Text tone="secondary">One compact ledger from proposal to human decision to applied revision.</Text>
        </div>
        <StateLabel
          label={`${state.page.proposals.length}${state.page.truncated ? "+" : ""} decision${state.page.proposals.length === 1 ? "" : "s"}`}
          size="compact"
          tone="neutral"
        />
      </header>
      <div className={styles.ledger}>
        {state.page.proposals.map((proposal) => (
          <ProposalRow
            actionFailed={state.actionFailure === proposal.proposalId}
            application={state.applications.get(proposal.proposalId)}
            isBusy={state.busyProposalId === proposal.proposalId}
            isGloballyBusy={state.busyProposalId !== null}
            key={proposal.proposalId}
            onApply={onApply}
            onRetry={onRetry}
            onReview={onReview}
            proposal={proposal}
            release={release}
            session={session}
          />
        ))}
      </div>
    </div>
  )
}

/** Connect one full release view to its authenticated repair-proposal ledger. */
export const RelationshipRepairPanel = ({
  release
}: {
  readonly release: PortfolioReleasePresentation
}): ReactElement => {
  const browserSession = useBrowserSession()
  const session = browserSession.state._tag === "authenticated" ? browserSession.state.session : null
  const controller = useRelationshipRepairProposals(release.id, session?.sessionId ?? null)
  if (session === null) return <LoadingPanel />
  return (
    <RelationshipRepairPanelView
      onApply={controller.apply}
      onRetry={controller.retry}
      onReview={controller.review}
      release={release}
      session={session}
      state={controller.state}
    />
  )
}
