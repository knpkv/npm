import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import { approvalNotRequiredLabel, approvalOf, approvalUnknownLabel } from "@knpkv/codecommit-core/Domain.js"
import { getScoreTier, type HealthScore } from "@knpkv/codecommit-core/HealthScore.js"
import { StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import { ArrowRightIcon } from "lucide-react"
import { Link } from "react-router"
import { extractScope } from "../utils/extractScope.js"
import type { PRRevisionViewProps } from "./pr-detail-view.js"
import { healthTone } from "./pr-detail-presentation.js"
import styles from "./pr-detail.module.css"

export type { PRRevisionViewProps } from "./pr-detail-view.js"

function ScoreBadge({ score }: { readonly score: HealthScore | undefined }) {
  // Unknown reads as a dash, never a red 0: the breakdown says which date is missing.
  if (score === undefined) return <StateLabel label="Health —" size="compact" tone="neutral" />
  const tier = getScoreTier(score.total)

  return <StateLabel label={`Health ${score.total.toFixed(1)} / 10`} size="compact" tone={healthTone(tier)} />
}

export function PRRevisionView({ health, pr, renderLifecycle }: PRRevisionViewProps) {
  const scope = extractScope(pr.title)
  return (
    <Surface as="section" className={styles.revisionCard} padding="spacious" form="grouped" tone="secondary">
      <header className={styles.revisionHeading}>
        <div>
          <Text tone="secondary" variant="label">
            Current revision
          </Text>
          <Text as="h2" variant="card-title">
            {pr.repositoryName}
          </Text>
          {/* In the text flow, not the corner, so the floating Relay dock can't cover it. */}
          <ScoreBadge score={health.score} />
        </div>
      </header>

      <div aria-label={`${pr.sourceBranch} into ${pr.destinationBranch}`} className={styles.branchPair}>
        <div>
          <Text tone="secondary" variant="meta">
            Source
          </Text>
          <code>{pr.sourceBranch}</code>
        </div>
        <ArrowRightIcon aria-hidden="true" />
        <div>
          <Text tone="secondary" variant="meta">
            Destination
          </Text>
          <code>{pr.destinationBranch}</code>
        </div>
      </div>

      <dl className={styles.facts}>
        <dt>Account</dt>
        <dd>
          <Link className={styles.codeLink} to={`/?f=account:${encodeURIComponent(pr.account.profile)}`}>
            {pr.account.profile}
          </Link>
        </dd>

        <dt>Repository</dt>
        <dd>
          <Link className={styles.codeLink} to={`/?f=repo:${encodeURIComponent(pr.repositoryName)}`}>
            {pr.repositoryName}
          </Link>
        </dd>

        <dt>Author</dt>
        <dd>
          <Link className={styles.textLink} to={`/?f=author:${encodeURIComponent(pr.author)}`}>
            {pr.author}
          </Link>
        </dd>

        {scope !== null && scope.length > 0 && (
          <>
            <dt>Scope</dt>
            <dd>
              <Link className={styles.textLink} to={`/?f=scope:${encodeURIComponent(scope)}`}>
                {scope}
              </Link>
            </dd>
          </>
        )}

        <dt>Status</dt>
        <dd className={styles.factStates}>
          {pr.status === "MERGED" ? (
            <Link className={styles.stateLink} to="/?f=status:merged">
              <StateLabel label="Merged" size="compact" tone="positive" />
            </Link>
          ) : pr.status === "CLOSED" ? (
            <Link className={styles.stateLink} to="/?f=status:closed">
              <StateLabel label="Closed" size="compact" tone="neutral" />
            </Link>
          ) : (
            <>
              {approvalOf(pr)._tag === "Unknown" ? (
                <StateLabel label={approvalUnknownLabel} size="compact" tone="neutral" />
              ) : approvalOf(pr)._tag === "NotRequired" ? (
                <StateLabel label={approvalNotRequiredLabel} size="compact" tone="neutral" />
              ) : (
                <Link
                  className={styles.stateLink}
                  to={`/?f=status:${approvalOf(pr)._tag === "Approved" ? "approved" : "pending"}`}
                >
                  <StateLabel
                    label={approvalOf(pr)._tag === "Approved" ? "Approved" : "Pending approval"}
                    size="compact"
                    tone={approvalOf(pr)._tag === "Approved" ? "positive" : "caution"}
                  />
                </Link>
              )}
              <Link className={styles.stateLink} to={`/?f=status:${pr.isMergeable ? "mergeable" : "conflicts"}`}>
                <StateLabel
                  label={pr.isMergeable ? "Mergeable" : "Conflict"}
                  size="compact"
                  tone={pr.isMergeable ? "positive" : "critical"}
                />
              </Link>
            </>
          )}
        </dd>

        <dt>Pull request ID</dt>
        <dd>
          <code>{pr.id}</code>
        </dd>

        <dt>Last activity</dt>
        <dd>
          <time dateTime={pr.lastModifiedDate.toISOString()}>{DateUtils.formatDate(pr.lastModifiedDate)}</time>
        </dd>

        {renderLifecycle(pr)}
      </dl>
    </Surface>
  )
}
