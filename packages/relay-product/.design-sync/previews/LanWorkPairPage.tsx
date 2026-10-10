// Fixtures from packages/herdr-hub/test/lan-work.test.ts.
import { LanWorkPairPage } from "@knpkv/relay-app-design-system"

export const Default = () => <LanWorkPairPage />
export const InvalidCode = () => <LanWorkPairPage error="Enter the 64-character pairing code" />
