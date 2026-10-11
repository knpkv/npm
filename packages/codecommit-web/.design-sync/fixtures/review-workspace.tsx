// Fixtures from packages/codecommit-web/test/pr-files-diff-view.test.ts and e2e/pr-review-workspace.spec.ts.
import { PullRequestId } from "@knpkv/codecommit-core/Domain.js"
import type { PRFilesDiffViewProps } from "@knpkv/codecommit-web/views"
import { findings } from "./findings.js"
import { noop } from "./pull-requests.js"

export const diff: PRFilesDiffViewProps["diff"] = {
  pullRequestId: PullRequestId.make("7"),
  revisionId: "r1",
  baseCommit: "base",
  headCommit: "abcdef0123456789",
  files: [
    { index: 0, status: "modified", path: "retry.ts", previousPath: null, beforeMode: "100644", afterMode: "100755" },
    { index: 1, status: "added", path: "new.ts", previousPath: null, beforeMode: null, afterMode: "100644" }
  ]
}
export const inventory: PRFilesDiffViewProps["inventory"] = {
  state: "ready",
  files: [
    { id: "0", path: "retry.ts", change: "modified", content: { state: "ready" } },
    { id: "1", path: "new.ts", change: "added", content: { state: "ready" } }
  ]
}

// Static text from the e2e file-content response, inside the bundle's selected-file slot.
const selectedDiff = (layout: PRFilesDiffViewProps["layout"]) => (
  <div style={{ display: "grid", gridTemplateColumns: layout === "split" ? "1fr 1fr" : "1fr", gap: 8, padding: 16 }}>
    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }} aria-label="Before">
      <code>- export const retries = 2</code>
    </pre>
    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }} aria-label="After">
      <code>+ export const retries = 3</code>
    </pre>
  </div>
)
const findingsPane = () => (
  <aside aria-label="Review findings" style={{ padding: 16 }}>
    <h3>Findings ({findings.length})</h3>
    <ul style={{ paddingInlineStart: 20 }}>
      {findings.map((finding) => (
        <li key={finding.id} style={{ marginBlockEnd: 16 }}>
          <strong>
            {finding.priority} · {finding.title}
          </strong>
          <p>{finding.summary}</p>
        </li>
      ))}
    </ul>
  </aside>
)

export const filesProps: PRFilesDiffViewProps = {
  diff,
  pullRequestId: diff.pullRequestId,
  diffFailure: null,
  inventory,
  selectedFile: diff.files[0],
  selectedFileMode: "100644 → 100755",
  layout: "split",
  wrap: false,
  workbenchRef: null,
  onSelectedFileChange: noop,
  onLayoutChange: noop,
  onWrapChange: noop,
  renderSelectedFile: () => selectedDiff("split"),
  findings: {
    placement: "column",
    open: false,
    label: "2 findings",
    triggerRef: { current: null },
    onOpen: noop,
    renderPane: findingsPane
  }
}

// Shared composition keeps the full-page slot and standalone cards on the same bundle view.
export const filesPropsFor = (overrides: Partial<PRFilesDiffViewProps> = {}): PRFilesDiffViewProps => {
  const props = { ...filesProps, ...overrides }
  return { ...props, renderSelectedFile: () => selectedDiff(props.layout) }
}
