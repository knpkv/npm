import { Button } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import styles from "./review-status-views.module.css"

export interface ReviewReadAgainActions {
  /** Re-read the existing workspace through the host's read adapter. Never execute a review. */
  readonly onReadAgain: () => void
  /**
   * Current focusable host target, retained across loading, missing, unavailable and ready readings.
   * Null, detached or non-focusable targets leave focus on Read again. The host owns completion announcements.
   */
  readonly focusTarget: () => HTMLElement | null
}

/** Move focus before the read can replace its button. All read notices share this one handoff. */
export function ReviewReadAgainButton({ focusTarget, onReadAgain }: ReviewReadAgainActions): ReactElement {
  return (
    <Button
      className={styles.readAgain}
      onClick={() => {
        const target = focusTarget()
        if (target?.isConnected === true) target.focus({ preventScroll: true })
        onReadAgain()
      }}
      size="compact"
      variant="primary"
    >
      Read again
    </Button>
  )
}
