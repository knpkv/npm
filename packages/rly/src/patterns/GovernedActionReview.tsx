import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useId } from "react"
import { Button } from "../primitives/Button.js"
import { StateLabel, type RlyStateTone } from "../primitives/StateLabel.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { type RlyAgentProposal, validateAgentProposal } from "./AgentProposal.js"
import { Person, type RlyPerson } from "./Person.js"
import styles from "./GovernedActionReview.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Caller-owned lifecycle of one governed action review. */
export type RlyGovernedActionState =
  "pending" | "rejected" | "authorized" | "executing" | "succeeded" | "failed" | "cancelled"

/** Props for a controlled human authorization review. */
export type GovernedActionReviewProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  readonly authorizeLabel?: string
  readonly confirmationLabel: string
  readonly isConfirmed: boolean
  readonly onAuthorize: () => void
  readonly onConfirmationChange: (confirmed: boolean) => void
  readonly onReject: () => void
  readonly outcome: ReactNode
  readonly proposal: RlyAgentProposal
  readonly rejectLabel?: string
  readonly reviewer: RlyPerson
  readonly state: RlyGovernedActionState
}

const statePresentation: Readonly<
  Record<RlyGovernedActionState, { readonly label: string; readonly tone: RlyStateTone }>
> = {
  pending: { label: "Awaiting human decision", tone: "caution" },
  rejected: { label: "Rejected by human reviewer", tone: "critical" },
  authorized: { label: "Authorized by human reviewer", tone: "positive" },
  executing: { label: "Authorized action executing", tone: "progress" },
  succeeded: { label: "Authorized action succeeded", tone: "positive" },
  failed: { label: "Authorized action failed", tone: "critical" },
  cancelled: { label: "Authorized action cancelled", tone: "neutral" }
}

/** Render a human decision gate without executing the proposed provider action. */
export const GovernedActionReview = ({
  authorizeLabel = "Authorize exact action",
  className,
  confirmationLabel,
  isConfirmed,
  onAuthorize,
  onConfirmationChange,
  onReject,
  outcome,
  proposal: suppliedProposal,
  rejectLabel = "Reject proposal",
  reviewer,
  state,
  ...props
}: GovernedActionReviewProps): ReactElement => {
  const proposal = validateAgentProposal(suppliedProposal)
  const visibleAuthorizeLabel = requireText(authorizeLabel, "GovernedActionReview authorizeLabel")
  const visibleConfirmationLabel = requireText(confirmationLabel, "GovernedActionReview confirmationLabel")
  const visibleRejectLabel = requireText(rejectLabel, "GovernedActionReview rejectLabel")
  requireText(reviewer.id, "GovernedActionReview reviewer id")
  requireText(reviewer.name, "GovernedActionReview reviewer name")
  requireText(reviewer.role, "GovernedActionReview reviewer role")
  const headingId = `rly-governed-action-${useId()}`
  const referenceId = `rly-governed-action-reference-${useId()}`
  const confirmationId = `rly-governed-confirmation-${useId()}`
  const presentedState = statePresentation[state]

  const authorize = (): void => {
    if (state === "pending" && isConfirmed) onAuthorize()
  }

  return (
    <section
      {...props}
      aria-labelledby={`${headingId} ${referenceId}`}
      className={classNames(style("root"), className)}
      data-rly-governed-action-state={state}
    >
      <header className={style("header")}>
        <div>
          <p className={style("eyebrow")}>Human authorization</p>
          <h2 className={style("heading")} id={headingId}>
            Review exact proposed action
          </h2>
          <code className={style("proposalReference")} id={referenceId}>
            {proposal.id}
          </code>
        </div>
        <StateLabel label={presentedState.label} tone={presentedState.tone} />
      </header>

      <p className={style("boundary")}>
        The agent proposed this action. Only the named human reviewer can authorize it.
      </p>

      <div className={style("reviewer")}>
        <span>Human reviewer</span>
        <Person person={reviewer} />
      </div>

      <dl className={style("facts")}>
        <div>
          <dt>Proposal</dt>
          <dd>{proposal.capability}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{proposal.target}</dd>
        </div>
        <div>
          <dt>Expected revision</dt>
          <dd>{proposal.expectedRevision}</dd>
        </div>
        <div>
          <dt>Impact</dt>
          <dd>{proposal.impact}</dd>
        </div>
      </dl>

      <div className={style("evidence")} data-rly-governed-action-evidence="">
        <h3>Evidence reviewed before decision</h3>
        <ul>
          {proposal.evidence.map((evidence) => (
            <li key={evidence.id}>
              <span>{evidence.label}</span>
              <code>{evidence.reference}</code>
            </li>
          ))}
        </ul>
      </div>

      {state === "pending" ? (
        <form className={style("decision")} onSubmit={(event) => event.preventDefault()}>
          <label className={style("confirmation")} htmlFor={confirmationId}>
            <input
              checked={isConfirmed}
              id={confirmationId}
              onChange={(event) => onConfirmationChange(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>{visibleConfirmationLabel}</span>
          </label>
          <p className={style("confirmationHelp")}>
            Confirm the exact proposal, target, revision, impact, and evidence above.
          </p>
          <div className={style("actions")}>
            <Button onClick={onReject} variant="secondary">
              {visibleRejectLabel}
            </Button>
            <Button disabled={!isConfirmed} onClick={authorize} variant="primary">
              {visibleAuthorizeLabel}
            </Button>
          </div>
        </form>
      ) : null}

      <div className={style("outcome")} data-rly-governed-action-outcome="">
        <h3>Recorded outcome</h3>
        {outcome}
      </div>
    </section>
  )
}
