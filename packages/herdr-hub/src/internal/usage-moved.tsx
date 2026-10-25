import { StatePanel } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"

/** What a Usage link shows on a hub without the Usage app: the hub's own Usage moved into one. */
export const UsageMovedPanel = (): ReactElement => (
  <StatePanel
    announce="polite"
    className="superapp-not-found"
    title="Usage is now an app."
    description={
      <>
        Install it on this machine with <code>herdr-hub apps add @knpkv/herdr-usage</code>, then reload.
      </>
    }
  />
)
