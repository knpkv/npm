import { Icon } from "@knpkv/rly/foundations"
import { Text } from "@knpkv/rly/primitives"
import { useMemo } from "react"
import type { FilterKey, FilterState } from "../atoms/ui.js"
import { filterLabels } from "./review-queue-state.js"
import styles from "./review-queue.module.css"

export interface SearchBarViewProps {
  readonly state: FilterState
  readonly onSearchChange: (text: string) => void
  readonly onToggleFilter: (key: FilterKey, value: string) => void
  readonly onClearDateRange: () => void
  readonly onClearAll: () => void
}

/** Controlled search and filter chips; URL mutations belong to the caller. */
export function SearchBarView({
  onClearAll,
  onClearDateRange,
  onSearchChange,
  onToggleFilter,
  state
}: SearchBarViewProps) {
  const selectedMap = useMemo(() => {
    const map = new Map<FilterKey, Array<string>>()
    for (const filter of state.filters) {
      const selected = map.get(filter.key)
      if (selected !== undefined) selected.push(filter.value)
      else map.set(filter.key, [filter.value])
    }
    return map
  }, [state.filters])

  const hasDateRange = Boolean(state.from || state.to)
  const hasAny = state.filters.length > 0 || state.review || state.q.length > 0 || hasDateRange
  const hasChips = state.filters.length > 0 || hasDateRange

  return (
    <div className={styles.searchBar}>
      <label className={styles.searchInputWrap}>
        <Text className={styles.visuallyHidden} variant="meta">
          Search pull requests
        </Text>
        <Icon className={styles.searchIcon ?? ""} decorative name="search" size="small" />
        <input
          className={styles.searchInput}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={hasChips ? "Refine by title, author, or branch" : "Search title, author, or branch"}
          type="search"
          value={state.q}
        />
      </label>

      {hasChips ? (
        <div aria-label="Active filters" className={styles.activeFilters}>
          {[...selectedMap.entries()].flatMap(([key, values]) =>
            values.map((value) => (
              <button
                // The name starts with the visible text, so saying "Status: open" reaches it.
                aria-label={`${filterLabels[key]}: ${value}, remove filter`}
                className={styles.filterChip}
                key={`${key}:${value}`}
                onClick={() => onToggleFilter(key, value)}
                type="button"
              >
                <span>{filterLabels[key]}:</span> {value}
                <Icon decorative name="close" size="small" />
              </button>
            ))
          )}
          {hasDateRange ? (
            <button
              aria-label={`Date: ${state.from ?? "Any"} → ${state.to ?? "Any"}, remove filter`}
              className={styles.filterChip}
              onClick={onClearDateRange}
              type="button"
            >
              <span>Date:</span> {state.from ?? "Any"} → {state.to ?? "Any"}
              <Icon decorative name="close" size="small" />
            </button>
          ) : null}
        </div>
      ) : null}

      {hasAny ? (
        <button aria-label="Clear search and filters" className={styles.clearSearch} onClick={onClearAll} type="button">
          Clear all
          <Icon decorative name="close" size="small" />
        </button>
      ) : null}
    </div>
  )
}
