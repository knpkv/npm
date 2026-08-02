import { Person, type RlyPerson } from "@knpkv/rly/patterns"
import { Text } from "@knpkv/rly/primitives"
import * as Match from "effect/Match"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { type ReactElement, type ReactNode, lazy, Suspense, useCallback, useMemo, useState } from "react"

import type { DurableAgentPrompt, PullRequestReviewState } from "../../api/agent.js"
import type { PrReviewSuggestion } from "../../domain/prReview.js"
import type { WorkspacePullRequestPresentation } from "./presentWorkspacePullRequest.js"
import type { ReviewSuggestionRevisionTransport } from "./useReviewSuggestionRevisions.js"
import type {
  PullRequestReviewControllerState,
  PullRequestReviewPublicationState,
  ReviewSuggestionPublicationTarget
} from "./usePullRequestReview.js"
import styles from "./WorkspacePullRequestDetails.module.css"
import { WorkspacePullRequestDiff } from "./WorkspacePullRequestDiff.js"
import { WorkspaceRichText } from "./WorkspaceRichText.js"

const PullRequestReviewPanel = lazy(() => import("./PullRequestReviewPanel.js"))

type CompletedPullRequestReview = Extract<PullRequestReviewState, { readonly _tag: "completed" }>
type CompletedPullRequestReviewResult =
  AsyncResult.Initial<CompletedPullRequestReview> | AsyncResult.Success<CompletedPullRequestReview>

const completedReviewResult = Match.type<PullRequestReviewControllerState>().pipe(
  Match.when({ _tag: "ready", review: { _tag: "completed" } }, ({ review }): CompletedPullRequestReviewResult =>
    AsyncResult.success(review)
  ),
  Match.orElse((): CompletedPullRequestReviewResult => AsyncResult.initial())
)

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

const People = ({ empty, people }: { readonly empty: string; readonly people: ReadonlyArray<RlyPerson> }) =>
  people.length === 0 ? (
    <Text tone="secondary">{empty}</Text>
  ) : (
    <ul className={styles.people}>
      {people.map((person) => (
        <li key={person.id}>
          <Person person={person} size="compact" />
        </li>
      ))}
    </ul>
  )

/** Render the exact CodeCommit revision as a compact review document. */
export const WorkspacePullRequestDetails = ({
  approvers,
  onReviewCancel,
  onReviewExtendBudget,
  onReviewLoadEarlier,
  onReviewPublicationCancel,
  onReviewPublicationPreview,
  onReviewRetry,
  onReviewStart,
  onReviewSuggestionPublish,
  onSessionExpired,
  pullRequest,
  reviewCanEnqueue,
  reviewPublication,
  reviewState,
  reviewSuggestionRevisionTransport,
  reviewers,
  sessionKey
}: {
  readonly approvers: ReadonlyArray<RlyPerson>
  readonly onSessionExpired: (sessionKey: string) => void
  readonly onReviewPublicationCancel: () => void
  readonly onReviewCancel: () => void
  readonly onReviewExtendBudget: () => void
  readonly onReviewLoadEarlier: () => void
  readonly onReviewPublicationPreview: (selection: ReviewSuggestionPublicationTarget) => void
  readonly onReviewRetry: () => void
  readonly onReviewSuggestionPublish: (finalContent: string) => void
  readonly onReviewStart: (prompt?: DurableAgentPrompt) => void
  readonly pullRequest: WorkspacePullRequestPresentation
  readonly reviewCanEnqueue: boolean
  readonly reviewPublication: PullRequestReviewPublicationState
  readonly reviewSuggestionRevisionTransport?: ReviewSuggestionRevisionTransport
  readonly reviewState: PullRequestReviewControllerState
  readonly reviewers: ReadonlyArray<RlyPerson>
  readonly sessionKey: string | null
}): ReactElement => {
  const completedReview = AsyncResult.builder(completedReviewResult(reviewState))
    .onInitial(() => null)
    .onSuccess((review) => review)
    .exhaustive()
  const reviewJobId = completedReview?.jobId ?? null
  const reportSuggestions = completedReview?.report.suggestions ?? []
  const [suggestionOverrides, setSuggestionOverrides] = useState<{
    readonly jobId: string | null
    readonly suggestions: ReadonlyMap<string, PrReviewSuggestion>
  }>(() => ({ jobId: reviewJobId, suggestions: new Map() }))
  const presentedSuggestions = useMemo(() => {
    if (suggestionOverrides.jobId !== reviewJobId) return reportSuggestions
    return reportSuggestions.map((suggestion) => {
      const accepted = suggestionOverrides.suggestions.get(suggestion.suggestionId)
      if (accepted === undefined) return suggestion
      return suggestion.state === "published" || suggestion.state === "resolved"
        ? { ...accepted, state: suggestion.state }
        : accepted
    })
  }, [reportSuggestions, reviewJobId, suggestionOverrides])
  const onSuggestionRevisionAccepted = useCallback(
    (suggestion: PrReviewSuggestion): void => {
      if (reviewJobId === null) return
      setSuggestionOverrides((current) => {
        const suggestions =
          current.jobId === reviewJobId ? new Map(current.suggestions) : new Map<string, PrReviewSuggestion>()
        suggestions.set(suggestion.suggestionId, suggestion)
        return { jobId: reviewJobId, suggestions }
      })
    },
    [reviewJobId]
  )

  return (
    <article className={styles.document} data-workspace-pull-request-detail>
      <div className={styles.revisionCard}>
        <div className={styles.branchPair}>
          <span>
            <small>Head</small>
            <strong>{pullRequest.sourceBranch}</strong>
          </span>
          <span aria-hidden="true" className={styles.direction}>
            →
          </span>
          <span>
            <small>Base</small>
            <strong>{pullRequest.targetBranch}</strong>
          </span>
        </div>
        <div className={styles.commitPair}>
          <code title={pullRequest.headRevision}>{pullRequest.headRevision}</code>
          <span>against</span>
          <code title={pullRequest.baseRevision ?? undefined}>
            {pullRequest.baseRevision ?? "Base revision unavailable"}
          </code>
        </div>
        <dl className={styles.revisionMeta}>
          <div>
            <dt>Created</dt>
            <dd>
              {pullRequest.createdAt === null ? (
                "Not synchronized"
              ) : (
                <time dateTime={pullRequest.createdAt.dateTime}>{pullRequest.createdAt.label}</time>
              )}
            </dd>
          </div>
          <div>
            <dt>Merge base</dt>
            <dd>{pullRequest.mergeBaseRevision ?? "Not synchronized"}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>
              {pullRequest.updatedAt === null ? (
                "Not synchronized"
              ) : (
                <time dateTime={pullRequest.updatedAt.dateTime}>{pullRequest.updatedAt.label}</time>
              )}
            </dd>
          </div>
        </dl>
      </div>

      <Section heading="Description" meta="What this revision changes">
        {pullRequest.description === null ? (
          <Text tone="secondary">No description was synchronized from CodeCommit.</Text>
        ) : (
          <WorkspaceRichText className={styles.description} value={pullRequest.description} />
        )}
      </Section>

      <Section heading="People" meta="Author, reviewers, and approvers">
        <div className={styles.peopleGroups}>
          <div>
            <Text tone="secondary" variant="meta">
              Author
            </Text>
            {pullRequest.author === null ? (
              <Text tone="secondary">No author identity was synchronized.</Text>
            ) : (
              <Person person={pullRequest.author} />
            )}
          </div>
          <div>
            <Text tone="secondary" variant="meta">
              Reviewers
            </Text>
            <People empty="No reviewer is assigned in the canonical workspace." people={reviewers} />
          </div>
          <div>
            <Text tone="secondary" variant="meta">
              Approvers
            </Text>
            <People empty="No approver is assigned in the canonical workspace." people={approvers} />
          </div>
        </div>
      </Section>

      <Section heading="Review" meta="Human decisions stay separate from agent advice">
        <div className={styles.reviewLanes}>
          <div>
            <small>Human decision</small>
            <strong>{pullRequest.reviewLabel}</strong>
            <span>Only provider and workspace evidence can change this state.</span>
          </div>
          <div>
            <small>Relay recommendation</small>
            <Suspense fallback={<span>Loading review tools…</span>}>
              <PullRequestReviewPanel
                canEnqueue={reviewCanEnqueue}
                onCancelReview={onReviewCancel}
                onCancelPublication={onReviewPublicationCancel}
                onExtendReviewBudget={onReviewExtendBudget}
                onLoadEarlier={onReviewLoadEarlier}
                onPreviewPublication={onReviewPublicationPreview}
                onPublishSuggestion={onReviewSuggestionPublish}
                onRetry={onReviewRetry}
                onStart={onReviewStart}
                onSuggestionRevisionAccepted={onSuggestionRevisionAccepted}
                publication={reviewPublication}
                {...(reviewSuggestionRevisionTransport === undefined
                  ? {}
                  : { revisionTransport: reviewSuggestionRevisionTransport })}
                state={reviewState}
                suggestions={presentedSuggestions}
              />
            </Suspense>
          </div>
        </div>
      </Section>

      <Section heading="Delivery evidence" meta="Connected work around this exact head">
        <dl className={styles.deliveryCounts}>
          <div>
            <dt>Jira items</dt>
            <dd>{pullRequest.issueCountLabel}</dd>
          </div>
          <div>
            <dt>Pipeline runs</dt>
            <dd>{pullRequest.pipelineCountLabel}</dd>
          </div>
          <div>
            <dt>Releases</dt>
            <dd>{pullRequest.releaseCountLabel}</dd>
          </div>
        </dl>
        <Text tone="secondary">The delivery relationships below explain every linked item and its evidence.</Text>
      </Section>

      <Section heading="Files" meta="Complete immutable diff">
        <WorkspacePullRequestDiff
          heading={`Pull request ${pullRequest.headRevision.slice(0, 12)}`}
          onSessionExpired={onSessionExpired}
          suggestions={presentedSuggestions}
          scope={pullRequest.diffScope}
          sessionKey={sessionKey}
        />
        {pullRequest.filesHref === null ? null : (
          <a className={styles.filesLink} href={pullRequest.filesHref} rel="noreferrer" target="_blank">
            Open this revision in CodeCommit
          </a>
        )}
      </Section>
    </article>
  )
}
