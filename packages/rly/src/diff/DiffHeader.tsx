import { type ComponentPropsWithRef, type ReactElement, useId } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import styles from "./DiffHeader.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Controlled diff arrangement. */
export type RlyDiffLayout = "split" | "stacked"

/** Controlled semantic finding filter. */
export type RlyDiffFindingFilter = "all" | "human" | "agent" | "unresolved"

/** Props for the complete diff inventory thesis and its application-controlled view preferences. */
export type DiffHeaderProps = Omit<ComponentPropsWithRef<"header">, "children"> & {
  readonly findingFilter: RlyDiffFindingFilter
  readonly heading: string
  readonly indexedCount: number
  readonly isWrapped: boolean
  readonly layout: RlyDiffLayout
  readonly onFindingFilterChange: (filter: RlyDiffFindingFilter) => void
  readonly onLayoutChange: (layout: RlyDiffLayout) => void
  readonly onWrapChange: (isWrapped: boolean) => void
  readonly selectedFileLabel?: string
  readonly totalCount: number
}

const findingFilters = ["all", "human", "agent", "unresolved"] satisfies ReadonlyArray<RlyDiffFindingFilter>
const layouts = ["split", "stacked"] satisfies ReadonlyArray<RlyDiffLayout>

const titleCase = (value: string): string => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`

const validateCounts = (indexedCount: number, totalCount: number): void => {
  if (!Number.isInteger(indexedCount) || !Number.isInteger(totalCount)) {
    throw new Error("DiffHeader counts must be integers")
  }
  if (indexedCount < 0 || totalCount < 0 || indexedCount > totalCount) {
    throw new Error("DiffHeader indexedCount must be between zero and totalCount")
  }
}

/** Render indexed progress and controlled preferences without fetching or rendering provider content. */
export const DiffHeader = ({
  className,
  findingFilter,
  heading,
  indexedCount,
  isWrapped,
  layout,
  onFindingFilterChange,
  onLayoutChange,
  onWrapChange,
  selectedFileLabel,
  totalCount,
  ...props
}: DiffHeaderProps): ReactElement => {
  const visibleHeading = requireText(heading, "DiffHeader heading")
  if (selectedFileLabel !== undefined) requireText(selectedFileLabel, "DiffHeader selectedFileLabel")
  validateCounts(indexedCount, totalCount)
  const progressId = `rly-diff-header-progress-${useId()}`

  return (
    <header {...props} className={classNames(style("root"), className)} data-rly-diff-layout={layout}>
      <section className={style("thesis")}>
        <span className={style("eyebrow")}>Complete diff</span>
        <h1>{visibleHeading}</h1>
        <p>{selectedFileLabel === undefined ? "All changed files" : selectedFileLabel}</p>
      </section>

      <section aria-labelledby={progressId} className={style("progress")}>
        <span className={style("progressCopy")} id={progressId}>
          <strong>{indexedCount}</strong>
          <span>of {totalCount} files indexed</span>
        </span>
        <progress max={Math.max(totalCount, 1)} value={indexedCount} />
      </section>

      <div className={style("controls")}>
        <div aria-label="Diff layout" className={style("group")} role="group">
          {layouts.map((option) => (
            <button aria-pressed={layout === option} key={option} onClick={() => onLayoutChange(option)} type="button">
              {titleCase(option)}
            </button>
          ))}
        </div>
        <button
          aria-pressed={isWrapped}
          className={style("standalone")}
          onClick={() => onWrapChange(!isWrapped)}
          type="button"
        >
          Wrap lines
        </button>
        <div aria-label="Finding filter" className={style("group")} role="group">
          {findingFilters.map((filter) => (
            <button
              aria-pressed={findingFilter === filter}
              key={filter}
              onClick={() => onFindingFilterChange(filter)}
              type="button"
            >
              {titleCase(filter)}
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}
