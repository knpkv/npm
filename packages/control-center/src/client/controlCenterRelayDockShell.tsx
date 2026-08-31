import { RelayProductDockProvider } from "@knpkv/relay-product/registry"
import { Component, lazy, type ReactElement, type ReactNode, Suspense } from "react"

const LazyControlCenterRelayDockChrome = lazy(async () => {
  const module = await import("./controlCenterRelayDockChrome.js")
  return { default: module.ControlCenterRelayDockChrome }
})

/** Keep routed content mounted while the product-specific Relay chrome loads. */
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

export const ControlCenterRelayDock = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <RelayProductDockProvider>
    {children}
    <RelayDockChromeBoundary>
      <Suspense fallback={null}>
        <LazyControlCenterRelayDockChrome />
      </Suspense>
    </RelayDockChromeBoundary>
  </RelayProductDockProvider>
)
