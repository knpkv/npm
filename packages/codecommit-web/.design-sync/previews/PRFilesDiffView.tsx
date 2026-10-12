// Fixtures from packages/codecommit-web/test/pr-files-diff-view.test.ts and e2e/pr-review-workspace.spec.ts.
import { PRFilesDiffView } from "@knpkv/codecommit-web-design-system"
import type { PRFilesDiffViewProps } from "@knpkv/codecommit-web/views"
import { diff, filesProps, filesPropsFor } from "../fixtures/review-workspace.js"

const workspace = (overrides: Partial<PRFilesDiffViewProps> = {}) => <PRFilesDiffView {...filesPropsFor(overrides)} />

/** Exact revision in split layout with the test's findings column. */
export const SplitWithFindings = () => workspace()
/** Retained revision remains readable under a new provider failure. */
export const LatestUnavailable = () => workspace({ diffFailure: "Provider unavailable." })
/** A provider revision with no changed files. */
export const Empty = () => workspace({ diff: { ...diff, files: [] }, inventory: { state: "ready", files: [] }, selectedFile: undefined, selectedFileMode: null })
/** Stacked lines with findings inline. */
export const Stacked = () => workspace({ layout: "stacked", wrap: true, findings: { ...filesProps.findings, placement: "inline" } })
/** Drawer content lives outside this view; this card shows the closed trigger. */
export const FindingsDrawerClosed = () => workspace({ findings: { ...filesProps.findings, placement: "drawer" } })
