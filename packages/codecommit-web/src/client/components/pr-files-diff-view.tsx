import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { CommitLabel } from "@knpkv/review/react"
import { DiffFileTree, type RlyDiffInventory } from "@knpkv/rly/diff/workbench"
import { Button, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import type { ReactNode, Ref, RefObject } from "react"
import type { PullRequestDiffResponse } from "../../server/Api.js"
import type { FindingsPlacement } from "./findings-drawer.js"
import styles from "./pr-review-workspace.module.css"

export interface PRFilesFindingsPresentation {
  readonly placement: FindingsPlacement
  readonly open: boolean
  readonly label: string
  readonly triggerRef: RefObject<HTMLButtonElement | null>
  readonly onOpen: () => void
  readonly renderPane: () => ReactNode
}

export interface PRFilesDiffViewProps {
  readonly diff: PullRequestDiffResponse
  readonly pullRequestId: Domain.PullRequestId
  readonly diffFailure: string | null
  readonly inventory: RlyDiffInventory
  readonly selectedFile: PullRequestDiffResponse["files"][number] | undefined
  readonly selectedFileMode: string | null
  readonly layout: "split" | "stacked"
  readonly wrap: boolean
  readonly findings: PRFilesFindingsPresentation
  readonly workbenchRef: Ref<HTMLDivElement>
  readonly onSelectedFileChange: (fileId: string) => void
  readonly onLayoutChange: (layout: "split" | "stacked") => void
  readonly onWrapChange: () => void
  readonly renderSelectedFile: () => ReactNode
}
export function PRFilesDiffView({
  diff,
  diffFailure,
  findings,
  inventory,
  layout,
  onLayoutChange,
  onSelectedFileChange,
  onWrapChange,
  pullRequestId,
  renderSelectedFile,
  selectedFile,
  selectedFileMode,
  workbenchRef,
  wrap
}: PRFilesDiffViewProps) {
  return (
    <Surface as="section" className={styles.workspace} padding="none" form="grouped">
      <header className={styles.workspaceHeader}>
        <div>
          <Text tone="secondary" variant="label">
            Exact-revision review
          </Text>
          <Text as="h2" variant="card-title">
            Diff
          </Text>
          <Text tone="secondary" variant="meta">
            {diff.files.length} changed {diff.files.length === 1 ? "file" : "files"} at head{" "}
            <CommitLabel commit={diff.headCommit} />
          </Text>
        </div>
        {findings.placement === "drawer" ? (
          <Button
            aria-expanded={findings.open}
            aria-haspopup="dialog"
            onClick={findings.onOpen}
            ref={findings.triggerRef}
            size="compact"
            variant="secondary"
          >
            {findings.label}
          </Button>
        ) : null}
      </header>

      {diffFailure === null ? null : (
        <div className={styles.reviewFailure}>
          <StatePanel
            announce="polite"
            description={`${diffFailure} Showing the last successfully loaded exact revision.`}
            title="Latest diff unavailable"
            tone="caution"
          />
        </div>
      )}

      <div className={styles.workbench} data-findings={findings.placement} ref={workbenchRef}>
        <DiffFileTree
          className={styles.fileTree}
          data={inventory}
          heading={`PR ${pullRequestId}`}
          onSelectedFileChange={onSelectedFileChange}
          {...(selectedFile === undefined ? {} : { selectedFileId: String(selectedFile.index) })}
        />

        <section aria-label="Selected file diff" className={styles.diffPane}>
          <header className={styles.diffToolbar}>
            <span>
              <code>{selectedFile?.path ?? "No changed file"}</code>
              {selectedFileMode === null ? null : <small>{selectedFileMode}</small>}
            </span>
            <div>
              <button aria-pressed={layout === "split"} onClick={() => onLayoutChange("split")} type="button">
                Split
              </button>
              <button aria-pressed={layout === "stacked"} onClick={() => onLayoutChange("stacked")} type="button">
                Stacked
              </button>
              <button aria-pressed={wrap} onClick={onWrapChange} type="button">
                Wrap
              </button>
            </div>
          </header>
          <div className={styles.diffViewport}>
            {selectedFile === undefined ? (
              <StatePanel
                description="CodeCommit reports no changed files for this revision."
                title="Empty diff"
                tone="neutral"
              />
            ) : (
              renderSelectedFile()
            )}
          </div>
        </section>

        {findings.placement === "drawer" ? null : findings.renderPane()}
      </div>
      <footer className={styles.workspaceFooter}>
        Relay is advisory. Accept posts immediately; acknowledge and reject stay local to this review session.
      </footer>
    </Surface>
  )
}
