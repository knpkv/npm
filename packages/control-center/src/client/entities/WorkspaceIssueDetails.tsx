import { Person } from "@knpkv/rly/patterns"
import { Text } from "@knpkv/rly/primitives"
import type { ReactElement, ReactNode } from "react"

import type { WorkspaceIssuePresentation } from "./presentWorkspaceIssue.js"
import styles from "./WorkspaceIssueDetails.module.css"
import { WorkspaceRichText } from "./WorkspaceRichText.js"

const Section = ({
  children,
  heading,
  meta
}: {
  readonly children: ReactNode
  readonly heading: string
  readonly meta?: string
}): ReactElement => (
  <section className={styles.section}>
    <header className={styles.sectionHeading}>
      <Text as="h2" variant="section-title">
        {heading}
      </Text>
      {meta === undefined ? null : (
        <Text tone="secondary" variant="meta">
          {meta}
        </Text>
      )}
    </header>
    {children}
  </section>
)

const RichText = ({ empty, value }: { readonly empty: string; readonly value: string | null }): ReactElement =>
  value === null ? (
    <Text tone="secondary">{empty}</Text>
  ) : (
    <WorkspaceRichText className={styles.richText} value={value} />
  )

/** Render a complete, read-only synchronized issue as a quiet working document. */
export const WorkspaceIssueDetails = ({ issue }: { readonly issue: WorkspaceIssuePresentation }): ReactElement => (
  <article className={styles.document} data-workspace-issue-detail>
    {issue.truncationMessage === null ? null : (
      <Text className={styles.boundaryNotice} tone="secondary">
        {issue.truncationMessage}
      </Text>
    )}

    <Section heading="Description" meta="What changes and why">
      <RichText empty="No description was synchronized from Jira." value={issue.description} />
    </Section>

    <Section heading="Acceptance criteria" meta="The finish line">
      <div className={styles.criteria}>
        <RichText empty="No acceptance criteria were synchronized." value={issue.acceptanceCriteria} />
      </div>
    </Section>

    {issue.environment === null ? null : (
      <Section heading="Environment" meta="Where this applies">
        <RichText empty="No environment was synchronized." value={issue.environment} />
      </Section>
    )}

    <Section heading="People" meta={`${String(issue.collaborators.length)} collaborators`}>
      {issue.collaborators.length === 0 ? (
        <Text tone="secondary">No Jira collaborator was synchronized for this issue.</Text>
      ) : (
        <ul className={styles.people}>
          {issue.collaborators.map((person) => (
            <li key={person.id}>
              <Person person={person} />
            </li>
          ))}
        </ul>
      )}
    </Section>

    <Section heading="Issue details" meta="Synchronized fields">
      <dl className={styles.metadata}>
        {issue.metadata.map((field) => (
          <div key={field.label}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </Section>

    {issue.parent === null && issue.subtasks.length === 0 ? null : (
      <Section heading="Related Jira work" meta="Source hierarchy">
        <div className={styles.related}>
          {issue.parent === null ? null : (
            <div>
              <Text tone="secondary" variant="meta">
                Parent
              </Text>
              <strong>{issue.parent.key}</strong>
              <span>{issue.parent.summary}</span>
              <small>{issue.parent.status}</small>
            </div>
          )}
          {issue.subtasks.map((subtask) => (
            <div key={subtask.key}>
              <Text tone="secondary" variant="meta">
                Subtask
              </Text>
              <strong>{subtask.key}</strong>
              <span>{subtask.summary}</span>
              <small>{subtask.status}</small>
            </div>
          ))}
        </div>
      </Section>
    )}

    <Section heading="Comments" meta={`${String(issue.commentCount)} comments`}>
      {issue.commentsTruncated ? (
        <Text className={styles.collectionNotice} tone="secondary">
          Only the newest synchronized comments are shown.
        </Text>
      ) : null}
      {issue.comments.length === 0 ? (
        <Text tone="secondary">No comment was synchronized for this issue.</Text>
      ) : (
        <ol className={styles.conversation}>
          {issue.comments.map((comment) => (
            <li key={comment.id}>
              <div className={styles.attribution}>
                <Person person={comment.author} size="compact" />
                {comment.time === null ? null : <time>{comment.time}</time>}
              </div>
              <WorkspaceRichText className={styles.commentBody} value={comment.body ?? "Comment body unavailable."} />
            </li>
          ))}
        </ol>
      )}
    </Section>

    <Section heading="History" meta={`${String(issue.historyCount)} changes`}>
      {issue.historyTruncated ? (
        <Text className={styles.collectionNotice} tone="secondary">
          Only the newest synchronized history is shown.
        </Text>
      ) : null}
      {issue.history.length === 0 ? (
        <Text tone="secondary">No field history was synchronized for this issue.</Text>
      ) : (
        <ol className={styles.history}>
          {issue.history.map((entry) => (
            <li key={entry.id}>
              <div className={styles.attribution}>
                <Person person={entry.actor} size="compact" />
                {entry.time === null ? null : <time>{entry.time}</time>}
              </div>
              <dl>
                {entry.changes.map((change, index) => (
                  <div key={`${change.field}:${String(index)}`}>
                    <dt>{change.field}</dt>
                    <dd>{change.transition}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ol>
      )}
    </Section>
  </article>
)
