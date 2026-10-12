import { type ReactElement, useEffect, useState } from "react"
import {
  ConnectionSynchronizationView,
  type ConnectionSynchronizationViewProps
} from "./ConnectionSynchronizationView.js"

export type { ConnectionSynchronizationViewState } from "./ConnectionSynchronizationView.js"

type ConnectionSynchronizationProps = Omit<ConnectionSynchronizationViewProps, "now">

/** Keep the application's half-minute clock outside the controlled synchronization view. */
export const ConnectionSynchronization = (props: ConnectionSynchronizationProps): ReactElement | null => {
  const active = props.state?._tag === "ready" || (props.state?._tag === "syncing" && props.state.previous !== null)
  const [clock, setClock] = useState(() => ({ active, now: active ? new Date() : new Date(0) }))
  // Resample when details appear while retaining the view's existing controls and focus.
  if (clock.active !== active) setClock({ active, now: active ? new Date() : new Date(0) })
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setClock({ active: true, now: new Date() }), 30_000)
    return () => clearInterval(timer)
  }, [active])
  return <ConnectionSynchronizationView {...props} now={clock.now} />
}
