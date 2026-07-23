import { StateLabel, Text } from "@knpkv/rly/primitives"
import type { ReactElement, ReactNode } from "react"
import { Link } from "react-router"

import type { WorkspaceClockifyTimeEntryPresentation } from "./presentWorkspaceClockifyTimeEntry.js"
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

/** Render one immutable Clockify entry as a quiet, deterministic time ledger. */
export const WorkspaceClockifyTimeEntryDetails = ({
  timeEntry
}: {
  readonly timeEntry: WorkspaceClockifyTimeEntryPresentation
}): ReactElement => (
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
            <dt>Type</dt>
            <dd>{timeEntry.entryTypeLabel}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{timeEntry.timerLabel}</dd>
          </div>
        </dl>
        <div className={styles.entryMeta}>
          <span>{timeEntry.taskLabel}</span>
          <span>{timeEntry.tagCountLabel}</span>
          <span>{timeEntry.lockLabel}</span>
        </div>
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

    <aside className={styles.readOnly}>
      <strong>{timeEntry.approvalLabel}</strong>
      <span>Corrections and approval remain read-only here. Make changes in Clockify.</span>
    </aside>
  </article>
)
