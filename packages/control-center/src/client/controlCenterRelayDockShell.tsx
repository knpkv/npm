import { RelayProductDockProvider } from "@knpkv/relay-product/registry"
import { Component, lazy, type ReactElement, type ReactNode, Suspense, useEffect } from "react"

const loadPanel = () => import("./controlCenterRelayPanel.js")

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
