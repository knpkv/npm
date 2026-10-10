import { Button, Notice } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import { dashboardRefreshTime } from "./internal/dashboard-refresh.js"

/**
 * The hub's refresh status, for the page gutter under the masthead. The polite status region is
 * always mounted and stays empty while refreshes succeed, so a failure is added to a live region
 * screen readers already watch; a region inserted together with its message may not be announced.
 */
export const RefreshStatus = ({
  failed,
  observedAt,
  onRetry
}: {
  readonly failed: boolean
  readonly observedAt: number
  readonly onRetry: () => void
}): ReactElement => (
  <div aria-live="polite" className="dashboard-refresh-status" role="status">
    {failed ? (
      <Notice
        action={
          <Button onClick={onRetry} size="dense" variant="quiet">
            Try again
          </Button>
        }
        className="dashboard-refresh-failed"
        tone="critical"
      >
        Couldn't refresh host activity. Showing the update from{" "}
        <time dateTime={new Date(observedAt).toISOString()}>{dashboardRefreshTime(observedAt)}</time>.
      </Notice>
    ) : null}
  </div>
)
