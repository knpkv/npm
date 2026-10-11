// Fixtures from packages/codecommit-web/e2e/pr-review-workspace.spec.ts.
import { RollingStatus } from "@knpkv/codecommit-web-design-system"

/** A tested progress message while the exact revision is being checked. */
export const CheckingRevision = () => <RollingStatus isLoading statusDetail="Checking exact revision" />
/** A tested progress message while Relay reviews the patch. */
export const ReviewingPatch = () => <RollingStatus isLoading statusDetail="Relay is reviewing the exact patch" />
