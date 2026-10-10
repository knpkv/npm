// Fixtures from packages/herdr-hub/test/refresh-status.test.tsx.
import { RefreshStatus } from "@knpkv/relay-app-design-system"

const noop = () => undefined

/** A refresh failed: the notice and its retry land in the already-mounted region. */
export const Failed = () => <RefreshStatus failed observedAt={1_000} onRetry={noop} />
