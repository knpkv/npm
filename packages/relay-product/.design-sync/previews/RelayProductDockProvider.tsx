// Fixtures from packages/relay-product/test/relay-product-panel.test.tsx.
import { RelayProductDockProvider, RelayProductLauncher } from "@knpkv/relay-app-design-system"

export const Default = () => (
  <RelayProductDockProvider>
    <RelayProductLauncher />
  </RelayProductDockProvider>
)
