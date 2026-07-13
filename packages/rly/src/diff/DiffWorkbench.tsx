import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import styles from "./DiffWorkbench.module.css"

const style = (name: string): string => cssClass(styles, name)

/** The application-controlled file scope shown by the workbench. */
export type RlyDiffWorkbenchScope =
  | { readonly label: string; readonly mode: "all-files" }
  | { readonly fileId: string; readonly label: string; readonly mode: "selected-file" }

/** One stable semantic finding slot, independent from virtualized line annotations. */
export interface RlyDiffWorkbenchFinding {
  readonly content: ReactNode
  readonly id: string
}

/** Presentation-only slots for a complete diff review surface. */
export type DiffWorkbenchProps = Omit<ComponentPropsWithRef<"section">, "aria-label" | "children"> & {
  readonly emptyFindings?: ReactNode
  readonly findings: ReadonlyArray<RlyDiffWorkbenchFinding>
  readonly findingsLabel?: string
  readonly header: ReactNode
  readonly inventory: ReactNode
  readonly inventoryLabel?: string
  readonly label: string
  readonly onShowAllFiles?: () => void
  readonly scope: RlyDiffWorkbenchScope
  readonly statusNotice?: ReactNode
  readonly viewer: ReactNode
  readonly viewerLabel?: string
}

const validateFindings = (findings: ReadonlyArray<RlyDiffWorkbenchFinding>): void => {
  const ids = new Set<string>()
  for (const finding of findings) {
    const id = requireText(finding.id, "DiffWorkbench finding id")
    if (ids.has(id)) throw new Error(`DiffWorkbench finding ids must be unique: ${id}`)
    ids.add(id)
  }
}

/** Compose complete inventory, renderer, and semantic evidence without owning application state. */
export const DiffWorkbench = ({
  className,
  emptyFindings = "No findings match this view.",
  findings,
  findingsLabel = "Semantic findings",
  header,
  inventory,
  inventoryLabel = "Changed files",
  label,
  onShowAllFiles,
  scope,
  statusNotice,
  viewer,
  viewerLabel = "Code changes",
  ...props
}: DiffWorkbenchProps): ReactElement => {
  const visibleLabel = requireText(label, "DiffWorkbench label")
  const visibleScopeLabel = requireText(scope.label, "DiffWorkbench scope label")
  const visibleInventoryLabel = requireText(inventoryLabel, "DiffWorkbench inventoryLabel")
  const visibleViewerLabel = requireText(viewerLabel, "DiffWorkbench viewerLabel")
  const visibleFindingsLabel = requireText(findingsLabel, "DiffWorkbench findingsLabel")
  if (scope.mode === "selected-file") {
    requireText(scope.fileId, "DiffWorkbench selected file id")
    if (onShowAllFiles === undefined) {
      throw new Error("DiffWorkbench selected-file scope requires onShowAllFiles")
    }
  }
  validateFindings(findings)

  return (
    <section
      {...props}
      aria-label={visibleLabel}
      className={classNames(style("root"), className)}
      data-rly-diff-scope={scope.mode}
      {...(scope.mode === "selected-file" ? { "data-rly-diff-selected-file": scope.fileId } : {})}
    >
      <div className={style("header")} data-rly-diff-workbench-slot="header">
        {header}
      </div>

      <div className={style("body")}>
        <section
          aria-label={visibleInventoryLabel}
          className={style("inventory")}
          data-rly-diff-workbench-slot="inventory"
        >
          {inventory}
        </section>

        <div className={style("review")}>
          <header className={style("scope")}>
            <span className={style("scopeLabel")}>{scope.mode === "all-files" ? "All files" : "Selected file"}</span>
            <strong className={style("scopeValue")}>{visibleScopeLabel}</strong>
            {scope.mode === "selected-file" ? (
              <button className={style("showAll")} onClick={onShowAllFiles} type="button">
                Show all files
              </button>
            ) : null}
          </header>
          {statusNotice === undefined ? null : (
            <div aria-live="polite" className={style("notice")} data-rly-diff-workbench-slot="status" role="status">
              {statusNotice}
            </div>
          )}
          <section aria-label={visibleViewerLabel} className={style("viewer")} data-rly-diff-workbench-slot="viewer">
            {viewer}
          </section>
        </div>

        <aside aria-label={visibleFindingsLabel} className={style("findings")} data-rly-diff-workbench-slot="findings">
          <header className={style("findingsHeader")}>
            <span>Review evidence</span>
            <h2>{visibleFindingsLabel}</h2>
            <strong aria-label={`${findings.length} findings`}>{findings.length}</strong>
          </header>
          {findings.length === 0 ? (
            <div className={style("empty")}>{emptyFindings}</div>
          ) : (
            <ol aria-label={`${visibleFindingsLabel} list`} className={style("findingList")} tabIndex={0}>
              {findings.map((finding) => (
                <li className={style("findingItem")} key={finding.id}>
                  {finding.content}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </section>
  )
}
