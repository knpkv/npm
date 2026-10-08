import { RelayProductDockProvider, useRelayProductOpen } from "@knpkv/relay-product/registry"
import { Component, lazy, type ReactElement, type ReactNode, Suspense, useEffect } from "react"

import styles from "./AppShell.module.css"

const loadPanel = () => import("./controlCenterRelayPanel.js")

// rly ships its patterns as one chunk, so the launcher loads lazily too, off the initial closure.
const LazyRelayLauncher = lazy(async () => {
  const module = await import("@knpkv/relay-product")
  return { default: module.RelayProductLauncher }
})

/**
 * Stands in for Relay's launcher until it loads: the same box (rly's launcher tokens), the same name,
 * and it already opens Relay, so the header never moves and an early click is not lost.
 */
const RelayLauncherStandIn = (): ReactElement => {
  const { open, setOpen } = useRelayProductOpen()
  return (
    <button
      aria-expanded={open}
      className={styles.relayLauncherStandIn}
      onClick={() => setOpen((current) => !current)}
      type="button"
    >
      <span aria-hidden="true" className={styles.relayLauncherStandInMark} />
      <span>Relay</span>
      <span aria-hidden="true" className={styles.relayLauncherStandInHint}>
        Ctrl J
      </span>
    </button>
  )
}

/** Relay's header launcher: the real one once its chunk has loaded, the same-size stand-in before. */
export const ControlCenterRelayLauncher = (): ReactElement => (
  <RelayDockChromeBoundary>
    <Suspense fallback={<RelayLauncherStandIn />}>
      <LazyRelayLauncher />
    </Suspense>
  </RelayDockChromeBoundary>
)

const LazyControlCenterRelayPanel = lazy(async () => {
  const module = await loadPanel()
  return { default: module.ControlCenterRelayPanel }
})

/** Keep routed content mounted if Relay's panel fails to load or render. */
export class RelayDockChromeBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state: RelayDockChromeBoundaryState = { failed: false }

  static getDerivedStateFromError(cause: unknown): RelayDockChromeBoundaryState {
    void cause
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

interface RelayDockChromeBoundaryState {
  readonly failed: boolean
}

/** Hold Relay's shared state (the registered PR thread, open and pin) for the whole app. */
export const ControlCenterRelayDock = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <RelayProductDockProvider>{children}</RelayProductDockProvider>
)

/**
 * Relay's panel slot, right after the header launcher. The panel renders only while open, so it loads
 * lazily; the chunk is fetched once the browser is idle, so the first open does not wait for it.
 */
export const ControlCenterRelayPanelSlot = (): ReactElement => {
  useEffect(() => {
    // Safari has no requestIdleCallback, which the DOM types promise; a short timeout after mount stands
    // in for idle there.
    const idle: Partial<Pick<Window, "cancelIdleCallback" | "requestIdleCallback">> = window
    if (idle.requestIdleCallback !== undefined) {
      const handle = idle.requestIdleCallback(() => void loadPanel())
      return () => idle.cancelIdleCallback?.(handle)
    }
    const handle = window.setTimeout(() => void loadPanel(), 2_000)
    return () => window.clearTimeout(handle)
  }, [])
  return (
    <RelayDockChromeBoundary>
      <Suspense fallback={null}>
        <LazyControlCenterRelayPanel />
      </Suspense>
    </RelayDockChromeBoundary>
  )
}
