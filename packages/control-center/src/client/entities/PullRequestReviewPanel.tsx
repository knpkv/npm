import { Button, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"

import type { PullRequestReviewControllerState } from "./usePullRequestReview.js"
import styles from "./WorkspacePullRequestDetails.module.css"

const unavailableMessage = (
  reason: Extract<PullRequestReviewControllerState, { readonly _tag: "ready" }>["review"] extends infer Review
    ? Review extends { readonly _tag: "unavailable"; readonly reason: infer Reason }
      ? Reason
      : never
    : never
): string => {
  switch (reason) {
    case "not-codecommit":
    case "not-pull-request":
      return "Agent review is available only for synchronized CodeCommit pull requests."
    case "source-stale":
      return "Synchronize this pull request before reviewing its immutable head."
    case "release-unavailable":
      return "Connect this pull request to a release before asking Relay to review it."
    case "base-revision-unavailable":
      return "The base revision has not been synchronized, so an exact review cannot start."
  }
}

const recommendationLabel = (recommendation: "changes-recommended" | "no-material-findings" | "unable-to-conclude") => {
  switch (recommendation) {
    case "changes-recommended":
      return "Changes recommended"
    case "no-material-findings":
      return "No material findings"
    case "unable-to-conclude":
      return "Unable to conclude"
  }
}

/** Render durable agent advice without conflating it with human disposition. */
export const PullRequestReviewPanel = ({
  canEnqueue,
  onRetry,
  onStart,
  state
}: {
  readonly canEnqueue: boolean
  readonly onRetry: () => void
  readonly onStart: () => void
  readonly state: PullRequestReviewControllerState
}): ReactElement => {
  if (state._tag === "idle" || state._tag === "loading") {
    return (
      <>
        <strong>Loading review state</strong>
        <span>Checking durable review history for this exact head.</span>
      </>
    )
  }
  if (state._tag === "failed") {
    return (
      <>
        <strong>Review state unavailable</strong>
        <span>The current review could not be loaded. No human decision was changed.</span>
        <Button onClick={onRetry}>Retry</Button>
      </>
    )
  }

  const review = state.review
  if (review._tag === "unavailable") {
    return (
      <>
        <strong>Review unavailable</strong>
        <span>{unavailableMessage(review.reason)}</span>
      </>
    )
  }
  if (review._tag === "pending") {
    const label =
      review.state === "queued"
        ? "Review queued"
        : review.state === "running"
          ? "Reviewing exact head"
          : "Cancellation requested"
    return (
      <>
        <strong>{label}</strong>
        <span>
          Relay is using {review.providerId} · {review.model}. This page updates automatically.
        </span>
        <code className={styles.reviewHead}>{review.subject.headRevision}</code>
      </>
    )
  }
  if (review._tag === "failed") {
    return (
      <>
        <strong>{review.state === "cancelled" ? "Review cancelled" : "Review did not finish"}</strong>
        <span>The failed run did not change approval or publish a recommendation.</span>
        {canEnqueue && state.provider !== null ? (
          <Button disabled={state.action === "starting"} onClick={onStart}>
            {state.action === "starting" ? "Starting…" : "Try again"}
          </Button>
        ) : null}
      </>
    )
  }
  if (review._tag === "completed") {
    return (
      <>
        <strong>{recommendationLabel(review.report.recommendation)}</strong>
        <Text>{review.report.summary}</Text>
        {review.report.findings.length === 0 ? (
          <span>No file-specific findings were retained for this exact head.</span>
        ) : (
          <ol className={styles.reviewFindings}>
            {review.report.findings.map((finding) => (
              <li data-severity={finding.severity} key={finding.findingId}>
                <div className={styles.findingHeading}>
                  <span>{finding.severity}</span>
                  <strong>{finding.title}</strong>
                </div>
                <code>
                  {finding.path}:{finding.startLine}
                  {finding.endLine === finding.startLine ? "" : `–${String(finding.endLine)}`}
                </code>
                <Text>{finding.detail}</Text>
                <div className={styles.preventionProposal}>
                  <small>Prevention proposal · separate review required</small>
                  <span>
                    {finding.prevention.summary} · {finding.prevention.enforcement}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
        <span>Agent advice only. A person must still approve or request changes.</span>
      </>
    )
  }

  return (
    <>
      <strong>Agent review not run</strong>
      <span>An immutable-head review produces advice, never a human approval.</span>
      {!canEnqueue ? (
        <span>Only a workspace owner can start a review.</span>
      ) : state.provider === null ? (
        <span>Configure a sandbox-safe OpenAI-compatible provider to enable review.</span>
      ) : (
        <Button disabled={state.action === "starting"} onClick={onStart}>
          {state.action === "starting" ? "Starting review…" : "Review exact head"}
        </Button>
      )}
      {state.action === "failed" ? (
        <span role="alert">The review could not be started. Check provider and worker configuration, then retry.</span>
      ) : null}
    </>
  )
}
