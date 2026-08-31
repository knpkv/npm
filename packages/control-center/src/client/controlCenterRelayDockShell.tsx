import { RelayProductDockProvider } from "@knpkv/relay-product/registry"
import { lazy, type ReactElement, type ReactNode, Suspense } from "react"

const LazyControlCenterRelayDockChrome = lazy(async () => {
  const module = await import("./controlCenterRelayDockChrome.js")
  return { default: module.ControlCenterRelayDockChrome }
})

/** Keep routed content mounted while the product-specific Relay chrome loads. */
export const ControlCenterRelayDock = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <RelayProductDockProvider>
    {children}
    <Suspense fallback={null}>
      <LazyControlCenterRelayDockChrome />
    </Suspense>
  </RelayProductDockProvider>
)
