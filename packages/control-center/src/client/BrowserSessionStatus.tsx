import type { ReactElement } from "react"
import { useBrowserSession } from "./BrowserSession.js"
import { BrowserSessionStatusView, type BrowserSessionStatusPresentation } from "./BrowserSessionStatusView.js"

interface BrowserSessionStatusProps {
  readonly anonymousAction?: "link" | "status"
}

/** Describe this browser's application-wide private session. */
export const BrowserSessionStatus = (props: BrowserSessionStatusProps = {}): ReactElement => {
  const { state } = useBrowserSession()
  const presentation: BrowserSessionStatusPresentation =
    state._tag === "authenticated"
      ? { _tag: "authenticated", permission: state.session.permission }
      : state._tag === "storage-unavailable"
        ? { _tag: "storage-unavailable", paired: state.session !== null }
        : state
  return <BrowserSessionStatusView {...props} presentation={presentation} />
}
