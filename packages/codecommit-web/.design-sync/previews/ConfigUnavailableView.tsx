// Fixtures from packages/codecommit-web/test/settings-sandbox.test.ts.
import { ConfigUnavailableView } from "@knpkv/codecommit-web-design-system"

const noop = () => {}
/** Config could not be read; retry is available. */
export const Unavailable = () => <ConfigUnavailableView path="fixture-config.json" connectionDetail={null} onRetry={noop} />
/** An unsigned browser needs a fresh sign-in link. */
export const SignedOut = () => <ConfigUnavailableView path="fixture-config.json" connectionDetail="Open a fresh owner sign-in link." onRetry={noop} />
