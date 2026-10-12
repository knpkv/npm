// Fixtures from packages/codecommit-web/test/pr-detail-view.test.ts and e2e/pr-review-workspace.spec.ts.
import { PRDescriptionView } from "@knpkv/codecommit-web-design-system"

/** The detail test's Markdown description. */
export const Markdown = () => <PRDescriptionView description="**Reason for the change**" />
/** The workspace e2e fixture's plain description. */
export const PlainText = () => <PRDescriptionView description="Keeps provider callbacks idempotent." />
