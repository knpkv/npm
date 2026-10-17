/** Read-only revision mismatch notice. Comparison never implies commit ancestry. @module */
import { CommitLabel } from "@knpkv/review/react"
import type { ReviewRunWorkspaceReading } from "@knpkv/review"
import { StateLabel } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import styles from "./review-status-views.module.css"

export interface ReviewDifferentRevisionViewProps {
  readonly reading: Extract<ReviewRunWorkspaceReading, { readonly _tag: "DifferentRevision" }>
}

/** Keep the recorded/current identities distinct. The parent displays findings away from current lines. */
export function ReviewDifferentRevisionView({
  reading: { current, run }
}: ReviewDifferentRevisionViewProps): ReactElement {
  return (
    <div className={styles.notice} data-review-revision="different" role="status">
      <div className={styles.copy}>
        <StateLabel icon="alert" label="Review is for a different revision" size="compact" tone="caution" />
        <p>
          This recorded review doesn’t match the current diff.
          {run.threads.some((thread) => thread.finding !== null)
            ? " Findings are shown separately from current diff lines."
            : null}
          {run.identity.headRevision !== current.headRevision ? (
            <>
              {" "}
              Reviewed <CommitLabel commit={run.identity.headRevision} />; the branch is now at{" "}
              <CommitLabel commit={current.headRevision} />.
            </>
          ) : null}
        </p>
      </div>
    </div>
  )
}
