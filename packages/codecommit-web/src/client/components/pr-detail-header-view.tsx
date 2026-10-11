import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import { ServiceMark } from "@knpkv/rly/patterns"
import { Button as RlyButton, Notice, StateLabel, Text } from "@knpkv/rly/primitives"
import { Link } from "react-router"
import type { PRDetailHeaderViewProps } from "./pr-detail-view.js"
import { pullRequestDecision, pullRequestStatusTone } from "./pr-detail-presentation.js"
import styles from "./pr-detail.module.css"

export type { PRDetailHeaderViewProps } from "./pr-detail-view.js"

export function PRDetailHeaderView({ actions, now, pr }: PRDetailHeaderViewProps) {
  const decision = pullRequestDecision(pr)
  const statusLabel = pr.status === "OPEN" ? "Open" : pr.status === "MERGED" ? "Merged" : "Closed"
  return (
    <>
      <nav aria-label="Pull request navigation" className={styles.backNavigation}>
        <RlyButton leadingIcon="arrow-left" onClick={actions.onBack} size="compact" variant="quiet">
          Back
        </RlyButton>
      </nav>

      <header className={styles.hero}>
        <Text as="h1" className={styles.title} variant="section-title">
          {pr.title}
        </Text>
        <div className={styles.heroMeta}>
          <ServiceMark service="codecommit" size="compact" />
          <span>
            Pull request {pr.id} by{" "}
            <Link className={styles.textLink} to={`/?f=author:${encodeURIComponent(pr.author)}`}>
              {pr.author}
            </Link>
            , opened <time dateTime={pr.creationDate.toISOString()}>{DateUtils.formatDate(pr.creationDate)}</time>.
            {pr.fetchedAt !== undefined ? <> {DateUtils.formatRelativeTime(pr.fetchedAt, now, "Fetched")}.</> : null}
          </span>
        </div>
      </header>

      <section aria-label="Pull request decision and actions" className={styles.decisionWorkspace}>
        {/* The review state is a sentence under the title, not the largest thing on the page. */}
        <Notice className={styles.verdict} tone={decision.tone}>
          <Text as="span" tone="inherit" variant="body-large">
            <strong>{decision.verdict}</strong> {decision.reason}
          </Text>
        </Notice>
        <aside className={styles.actionRail}>
          <div className={styles.actionHeading}>
            <Text tone="secondary" variant="label">
              Actions
            </Text>
            <StateLabel label={statusLabel} size="compact" tone={pullRequestStatusTone(pr.status)} />
          </div>
          <div className={styles.actionGroup}>
            <RlyButton
              className={styles.actionButton}
              loading={actions.isRefreshing}
              onClick={actions.onRefresh}
              size="compact"
              variant="secondary"
            >
              Refresh
            </RlyButton>
            <RlyButton
              className={styles.actionButton}
              onClick={actions.onSubscriptionToggle}
              size="compact"
              variant="secondary"
            >
              {actions.isSubscribed ? "Unsubscribe" : "Subscribe"}
            </RlyButton>
            <RlyButton className={styles.actionButton} onClick={actions.onSandbox} size="compact" variant="secondary">
              {actions.sandboxState === "stopping"
                ? "Stopping…"
                : actions.sandboxState === "open"
                  ? "Open Sandbox"
                  : "Sandbox"}
            </RlyButton>
            <RlyButton className={styles.actionButton} onClick={actions.onCopyLink} size="compact" variant="secondary">
              {actions.copied ? "Copied" : "Copy Link"}
            </RlyButton>
            <RlyButton
              className={styles.actionButton}
              leadingIcon="external-link"
              onClick={actions.onOpenConsole}
              size="compact"
              variant="primary"
            >
              Open in Console
            </RlyButton>
          </div>
          <Text tone="secondary" variant="meta">
            Enter or O opens CodeCommit. Period opens the sandbox. Esc returns to the list.
          </Text>
        </aside>
      </section>
    </>
  )
}
