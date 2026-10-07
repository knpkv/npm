/**
 * One decision-queue row.
 *
 * The complete row remains one keyboard-focusable link while state, review
 * ownership, health, repository, revision, author, and activity facts stay
 * visible without relying on color alone.
 *
 * @module
 */
import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import {
  calculateHealthScore,
  getScoreTier,
  type HealthScore,
  healthUnknownReason
} from "@knpkv/codecommit-core/HealthScore.js"
import { ServiceMark } from "@knpkv/rly/patterns"
import { StateLabel, Text } from "@knpkv/rly/primitives"
import { Option } from "effect"
import { ArrowRightIcon, MessageSquareIcon } from "lucide-react"
import { useMemo } from "react"
import { Link } from "react-router"
import {
  pullRequestRowDecision,
  pullRequestRowStatus,
  pullRequestRowTimeLabel,
  pullRequestRowTimestamp
} from "./pr-row-presentation.js"
import styles from "./review-queue.module.css"
import { type Caller, needsYourReview } from "./workbench-queue.js"

interface PRRowProps {
  readonly pr: PullRequest
  readonly to: string
  readonly showUpdated?: boolean
  readonly caller: Caller
}

const scoreClassName = (tier: ReturnType<typeof getScoreTier>): string => {
  switch (tier) {
    case "green":
      return styles.scorePositive ?? ""
    case "yellow":
      return styles.scoreCaution ?? ""
    default:
      return styles.scoreCritical ?? ""
  }
}

export function PRRow({ caller, pr, showUpdated, to }: PRRowProps) {
  const reviewRequested = needsYourReview(pr, caller)
  const score: HealthScore | undefined = useMemo(
    () => Option.getOrUndefined(calculateHealthScore(pr, new Date())),
    [pr]
  )
  const status = pullRequestRowStatus(pr)
  const decision = pullRequestRowDecision(pr)
  const description = pr.description?.split("\n").slice(0, 2).join(" ")

  return (
    <Link className={styles.prRow} to={to}>
      <div className={styles.prMain}>
        <div className={styles.prKicker}>
          <ServiceMark service="codecommit" size="compact" />
          <Text className={styles.prNumber} tone="inherit" variant="code">
            PR #{pr.id}
          </Text>
          <StateLabel label={status.label} size="compact" tone={status.tone} />
          {reviewRequested ? <StateLabel label="Needs your review" size="compact" tone="caution" /> : null}
        </div>
        <Text as="h3" className={styles.prTitle} variant="card-title">
          {pr.title}
        </Text>
        {description ? (
          <Text className={styles.prDescription} tone="secondary" variant="meta">
            {description}
          </Text>
        ) : null}
        <div className={styles.prByline}>
          <Text tone="secondary" variant="meta">
            {pr.author},
          </Text>
          <Text
            as="time"
            dateTime={pullRequestRowTimestamp(pr, showUpdated === true).toISOString()}
            tone="tertiary"
            variant="meta"
          >
            {pullRequestRowTimeLabel(pr, showUpdated === true, new Date())}
          </Text>
          {pr.commentCount !== undefined && pr.commentCount > 0 ? (
            <span aria-label={`${pr.commentCount} comments`} className={styles.commentCount}>
              <MessageSquareIcon aria-hidden="true" />
              {pr.commentCount}
            </span>
          ) : null}
        </div>
      </div>

      <dl className={styles.prFacts}>
        <div className={styles.prFact}>
          <dt>Repository</dt>
          <dd>{pr.repositoryName}</dd>
        </div>
        <div className={styles.prFact}>
          <dt>Revision</dt>
          <dd title={`${pr.sourceBranch} into ${pr.destinationBranch}`}>
            {pr.sourceBranch} into {pr.destinationBranch}
          </dd>
        </div>
      </dl>

      <div className={styles.prDecision}>
        {score ? (
          <div className={styles.health}>
            <Text tone="tertiary" variant="meta">
              Health
            </Text>
            <span className={`${styles.healthScore ?? ""} ${scoreClassName(getScoreTier(score.total))}`}>
              {score.total.toFixed(1)}
            </span>
          </div>
        ) : (
          // Unknown: CodeCommit left out a date the score depends on.
          <div
            className={styles.health}
            title={`Not enough data to score: ${Option.getOrElse(healthUnknownReason(pr), () => "no dates")}.`}
          >
            <Text tone="tertiary" variant="meta">
              Health
            </Text>
            <span aria-label="unknown" className={styles.healthScore}>
              —
            </span>
          </div>
        )}
        <Text className={styles.approvalCount} tone="tertiary" variant="meta">
          {decision.summary}
        </Text>
        <span className={styles.openReview}>
          {decision.actionLabel}
          <ArrowRightIcon aria-hidden="true" />
        </span>
      </div>
    </Link>
  )
}
