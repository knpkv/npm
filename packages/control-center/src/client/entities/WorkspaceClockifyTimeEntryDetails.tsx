import { StateLabel, Text } from "@knpkv/rly/primitives"
import { useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react"
import { Link } from "react-router"

import type { SubmitClockifyActionRequest } from "../../api/deliveryGraph.js"
import type { WorkspaceClockifyTimeEntryPresentation } from "./presentWorkspaceClockifyTimeEntry.js"
import type { ClockifyActionSubmissionState } from "./useClockifyActionSubmission.js"
import styles from "./WorkspaceClockifyTimeEntryDetails.module.css"

const Section = ({
  children,
  heading,
  meta
}: {
  readonly children: ReactNode
  readonly heading: string
  readonly meta: string
}): ReactElement => (
  <section className={styles.section}>
    <header className={styles.sectionHeading}>
      <Text as="h2" variant="section-title">
        {heading}
      </Text>
      <Text tone="secondary" variant="meta">
        {meta}
      </Text>
    </header>
    {children}
  </section>
)

/** Render one immutable Clockify entry and its Control Center-owned approval. */
export const WorkspaceClockifyTimeEntryDetails = ({
  canApprove = false,
  canCorrect = false,
  onSubmit,
  submission = { _tag: "idle" },
  timeEntry
}: {
  readonly canApprove?: boolean
  readonly canCorrect?: boolean
  readonly onSubmit?: (request: SubmitClockifyActionRequest) => void
  readonly submission?: ClockifyActionSubmissionState
  readonly timeEntry: WorkspaceClockifyTimeEntryPresentation
}): ReactElement => {
  const [jiraIssueKey, setJiraIssueKey] = useState("")
  const [rationale, setRationale] = useState("")
  const approvalDecision = useRef<"approved" | "rejected">("approved")
  const correctionDisabled = !canCorrect || onSubmit === undefined || submission._tag === "submitting"
  const approvalDisabled = !canApprove || onSubmit === undefined || submission._tag === "submitting"
  const submitCorrection = (event: FormEvent): void => {
    event.preventDefault()
    if (!correctionDisabled)
      onSubmit({
        _tag: "correct-association",
        expectedRevision: timeEntry.sourceRevision,
        jiraIssueKey
      })
  }
  const submitApproval = (event: FormEvent): void => {
    event.preventDefault()
    if (!approvalDisabled && rationale.trim().length > 0) {
      onSubmit({
        _tag: "record-approval",
        expectedRevision: timeEntry.sourceRevision,
        decision: approvalDecision.current,
        rationale: rationale.trim()
      })
      approvalDecision.current = "approved"
    }
  }
  return (
    <article className={styles.document} data-workspace-clockify-time-entry-detail>
      <section aria-label="Clockify time ledger" className={styles.ledger}>
        <div className={styles.total}>
          <span>Total tracked</span>
          <strong>{timeEntry.durationLabel}</strong>
          <small>{timeEntry.rollupLabel}</small>
        </div>
        <div className={styles.ledgerBody}>
          <header>
            <span>Time ledger</span>
            <StateLabel
              label={timeEntry.associationLabel}
              tone={timeEntry.jiraAssociations.length === 0 ? "caution" : "positive"}
            />
          </header>
          <p>{timeEntry.description}</p>
          <dl className={styles.primaryFacts}>
            <div>
              <dt>Project</dt>
              <dd>{timeEntry.projectLabel}</dd>
            </div>
            <div>
              <dt>Billing</dt>
              <dd>{timeEntry.billableLabel}</dd>
            </div>
            <div>
              <dt>Contributor</dt>
              <dd>{timeEntry.contributorLabel}</dd>
            </div>
          </dl>
        </div>
      </section>

      <Section heading="Entry" meta="The exact source record included in the total">
        <div className={styles.entry}>
          <strong>{timeEntry.durationLabel}</strong>
          <dl>
            <div>
              <dt>Started</dt>
              <dd>{timeEntry.startedAt}</dd>
            </div>
            <div>
              <dt>Ended</dt>
              <dd>{timeEntry.endedAt}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{timeEntry.timerLabel}</dd>
            </div>
            <div>
              <dt>Provider lock</dt>
              <dd>{timeEntry.lockLabel}</dd>
            </div>
          </dl>
        </div>
      </Section>

      <Section heading="Jira attribution" meta="Current delivery-ledger relationships">
        <div className={styles.attribution} data-state={timeEntry.jiraAssociations.length === 0 ? "missing" : "linked"}>
          <div>
            <strong>{timeEntry.associationLabel}</strong>
            <p>{timeEntry.associationDetail}</p>
          </div>
          {timeEntry.jiraAssociations.length === 0 ? null : (
            <ul>
              {timeEntry.jiraAssociations.map((association) => (
                <li key={association.href}>
                  <Link to={association.href}>
                    <span>{association.key}</span>
                    <strong>{association.title}</strong>
                    <small>
                      {association.state === "inferred" ? "Inferred" : "Linked"} · {association.evidenceLabel}
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section heading="People" meta="Provider contributor and assigned approvers">
        <dl className={styles.people}>
          <div>
            <dt>Contributor</dt>
            <dd>{timeEntry.contributorLabel}</dd>
          </div>
          <div>
            <dt>Approvers</dt>
            <dd>{timeEntry.approvers.join(" · ") || "No approval recorded"}</dd>
          </div>
        </dl>
      </Section>

      <aside className={styles.readOnly} data-clockify-approval>
        <strong>Control Center approval: {timeEntry.approvalLabel}</strong>
        <span>{timeEntry.approvalDetail}</span>
        {timeEntry.approvalDecidedAt === null ? null : (
          <time dateTime={timeEntry.approvalDecidedAt.dateTime}>Recorded {timeEntry.approvalDecidedAt.label}</time>
        )}
      </aside>
      <section aria-label="Governed Clockify actions" data-clockify-governed-actions>
        <form onSubmit={submitCorrection}>
          <label>
            Jira issue key
            <input
              disabled={correctionDisabled}
              maxLength={100}
              onChange={(event) => setJiraIssueKey(event.currentTarget.value)}
              pattern="[A-Z][A-Z0-9]*-[1-9][0-9]*"
              required
              value={jiraIssueKey}
            />
          </label>
          <button disabled={correctionDisabled} type="submit">
            Correct association
          </button>
        </form>
        <form onSubmit={submitApproval}>
          <label>
            Approval rationale
            <input
              disabled={approvalDisabled}
              maxLength={1_000}
              onChange={(event) => setRationale(event.currentTarget.value)}
              required
              value={rationale}
            />
          </label>
          <button
            disabled={approvalDisabled || rationale.trim().length === 0}
            onClick={() => {
              approvalDecision.current = "approved"
            }}
            type="submit"
          >
            Approve revision
          </button>
          <button
            disabled={approvalDisabled || rationale.trim().length === 0}
            onClick={() => {
              approvalDecision.current = "rejected"
            }}
            type="submit"
          >
            Reject revision
          </button>
        </form>
        {submission._tag === "failed" ? <p role="alert">The governed action could not be submitted.</p> : null}
        {submission._tag === "succeeded" ? <p>Action recorded: {submission.result.state}</p> : null}
      </section>
    </article>
  )
}
