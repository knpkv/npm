/** Read-only missing-history states from export 64. The host owns retry and surrounding diff/comments. @module */
import { StateLabel } from "@knpkv/rly/primitives"
import type { ReviewConversations, ReviewRunReading } from "@knpkv/review"
import type { ReactElement } from "react"
import { ReviewReadAgainButton, type ReviewReadAgainActions } from "./review-read-again-button.js"
import styles from "./review-status-views.module.css"

export interface ReviewRunFallbackViewProps {
  /** Ready runs belong to the summary/findings view, never this missing-history panel. */
  readonly reading: Exclude<ReviewRunReading, { readonly _tag: "Ready" }>
  /** Comments availability is independent from recorded agent history. */
  readonly conversations: ReviewConversations
  /** Null when the Threads notice owns the single retry for this host reading. */
  readonly readAgain: ReviewReadAgainActions | null
}

/** Keep missing and unreadable history distinct, with no invented verdict or write controls. */
export function ReviewRunFallbackView({ conversations, readAgain, reading }: ReviewRunFallbackViewProps): ReactElement {
  return (
    <section aria-label="Review summary" className={styles.summary} data-review-run-fallback={reading._tag}>
      {reading._tag === "NotRecorded" ? (
        <h2 className={styles.noRun}>No agent review yet</h2>
      ) : (
        <div className={styles.notice} role="status">
          <div className={styles.copy}>
            <StateLabel icon="alert" label="Review history unavailable" size="compact" tone="caution" />
            <p>
              The recorded agent review could not be read on this host.{" "}
              {conversations._tag === "Ready"
                ? "The diff and comments are still available."
                : "The diff is still available."}
            </p>
          </div>
          {readAgain !== null ? (
            <div className={styles.action}>
              <ReviewReadAgainButton focusTarget={readAgain.focusTarget} onReadAgain={readAgain.onReadAgain} />
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
