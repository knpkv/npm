import { Icon } from "@knpkv/rly/foundations"
import { Text } from "@knpkv/rly/primitives"
import { useMemo } from "react"
import { useSearchParams } from "react-router"
import type { FilterKey } from "../atoms/ui.js"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { filterLabels } from "./review-queue-state.js"
import styles from "./review-queue.module.css"

export function SearchBar() {
  const { clearAll, setFilterText, state, toggleFilter } = useFilterParams()
  const [, setSearchParams] = useSearchParams()

  const selectedMap = useMemo(() => {
    const map = new Map<FilterKey, Array<string>>()
    for (const filter of state.filters) {
      const selected = map.get(filter.key)
      if (selected) selected.push(filter.value)
      else map.set(filter.key, [filter.value])
    }
    return map
  }, [state.filters])

  const hasDateRange = Boolean(state.from || state.to)
  const hasAny = state.filters.length > 0 || state.review || state.q.length > 0 || hasDateRange
  const hasChips = state.filters.length > 0 || hasDateRange

  const clearDateRange = (): void => {
    setSearchParams(
      (previous) => {
        previous.delete("from")
        previous.delete("to")
        return previous
      },
      { preventScrollReset: true, replace: true }
    )
  }

  return (
    <div className={styles.searchBar}>
      <label className={styles.searchInputWrap}>
        <Text className={styles.visuallyHidden} variant="meta">
          Search pull requests
        </Text>
        <Icon className={styles.searchIcon ?? ""} decorative name="search" size="small" />
        <input
          className={styles.searchInput}
          onChange={(event) => setFilterText(event.target.value)}
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
                aria-label={`Remove ${filterLabels[key]} filter ${value}`}
                className={styles.filterChip}
                key={`${key}:${value}`}
                onClick={() => toggleFilter(key, value)}
                type="button"
              >
                <span>{filterLabels[key]}:</span> {value}
                <Icon decorative name="close" size="small" />
              </button>
            ))
          )}
          {hasDateRange ? (
            <button
              aria-label="Remove date range filter"
              className={styles.filterChip}
              onClick={clearDateRange}
              type="button"
            >
              <span>Date:</span> {state.from ?? "Any"} → {state.to ?? "Any"}
              <Icon decorative name="close" size="small" />
            </button>
          ) : null}
        </div>
      ) : null}

      {hasAny ? (
        <button aria-label="Clear search and filters" className={styles.clearSearch} onClick={clearAll} type="button">
          Clear all
          <Icon decorative name="close" size="small" />
        </button>
      ) : null}
    </div>
  )
}
