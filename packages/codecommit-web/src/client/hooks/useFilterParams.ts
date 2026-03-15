/**
 * URL search-param filter hook — bidirectional sync between URL and FilterState.
 *
 * Parses `?f=key:value` params into {@link FilterState}, injects defaults
 * when no `f=` is present, and provides toggle/remove/clear callbacks for
 * all filter dimensions (account, author, repo, status, etc.), hot mode
 * (`?hot=1`), review mode (`?review=1`), mine mode (`?mine=1`), text
 * search (`?q=`), and date range (`?from=`/`?to=`).
 *
 * **Common tasks**
 *
 * - Toggle review filter: toggleReview
 * - Toggle hot mode: toggleHot
 * - Clear all filters: clearAll
 *
 * @module
 */
import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router"
import { FILTER_KEYS, type FilterEntry, type FilterKey, type FilterState } from "../atoms/ui.js"

const isFilterKey = (k: string): k is FilterKey => (FILTER_KEYS as ReadonlyArray<string>).includes(k)

const DEFAULT_FILTERS: ReadonlyArray<FilterEntry> = [{ key: "status", value: "open" }]
const DEFAULT_FILTER_PARAMS = DEFAULT_FILTERS.map((f) => `${f.key}:${f.value}`)

function parseFilters(params: URLSearchParams): ReadonlyArray<FilterEntry> {
  const rawEntries = params.getAll("f")
  // No explicit f= params → apply defaults
  if (rawEntries.length === 0) return DEFAULT_FILTERS

  const entries: Array<FilterEntry> = []
  for (const raw of rawEntries) {
    const idx = raw.indexOf(":")
    if (idx < 1) continue
    const key = raw.slice(0, idx)
    const value = raw.slice(idx + 1)
    if (!isFilterKey(key) || !value) continue
    // Dedupe exact key:value pairs
    if (entries.some((e) => e.key === key && e.value === value)) continue
    entries.push({ key, value })
  }
  return entries
}

export function useFilterParams() {
  const [searchParams, setSearchParams] = useSearchParams()

  const state: FilterState = useMemo(() => {
    const mineScope = searchParams.get("mineScope")
    const from = searchParams.get("from")
    const to = searchParams.get("to")
    return {
      filters: parseFilters(searchParams),
      hot: searchParams.has("hot"),
      mine: searchParams.has("mine"),
      review: searchParams.has("review"),
      ...(mineScope != null ? { mineScope } : {}),
      q: searchParams.get("q") ?? "",
      ...(from != null ? { from } : {}),
      ...(to != null ? { to } : {})
    }
  }, [searchParams])

  /** Toggle a filter value — adds if missing, removes if present */
  const toggleFilter = useCallback(
    (key: FilterKey, value: string) => {
      setSearchParams((prev) => {
        let existing = prev.getAll("f")
        const target = `${key}:${value}`

        // Materialize defaults into URL when no explicit f= params
        if (existing.length === 0) {
          for (const d of DEFAULT_FILTER_PARAMS) prev.append("f", d)
          existing = prev.getAll("f")
        }

        const has = existing.includes(target)
        prev.delete("f")
        for (const raw of existing) {
          if (raw === target || raw === "") continue
          prev.append("f", raw)
        }
        if (!has) prev.append("f", target)

        // Sentinel prevents default re-injection when all filters removed
        if (prev.getAll("f").length === 0 && has) {
          prev.append("f", "")
        }

        return prev
      }, { replace: true })
    },
    [setSearchParams]
  )

  /** Remove all values for a given key */
  const removeFilterKey = useCallback(
    (key: FilterKey) => {
      setSearchParams((prev) => {
        let existing = prev.getAll("f")

        if (existing.length === 0) {
          for (const d of DEFAULT_FILTER_PARAMS) prev.append("f", d)
          existing = prev.getAll("f")
        }

        prev.delete("f")
        for (const raw of existing) {
          if (raw === "" || raw.slice(0, raw.indexOf(":")) === key) continue
          prev.append("f", raw)
        }

        if (prev.getAll("f").length === 0) {
          prev.append("f", "")
        }

        return prev
      }, { replace: true })
    },
    [setSearchParams]
  )

  const toggleHot = useCallback(() => {
    setSearchParams((prev) => {
      if (prev.has("hot")) prev.delete("hot")
      else prev.set("hot", "1")
      return prev
    }, { replace: true })
  }, [setSearchParams])

  const toggleReview = useCallback(() => {
    setSearchParams((prev) => {
      if (prev.has("review")) prev.delete("review")
      else prev.set("review", "1")
      return prev
    }, { replace: true })
  }, [setSearchParams])

  const toggleMine = useCallback(() => {
    setSearchParams((prev) => {
      if (prev.has("mine")) {
        prev.delete("mine")
        prev.delete("mineScope")
      } else {
        prev.set("mine", "1")
      }
      return prev
    }, { replace: true })
  }, [setSearchParams])

  const setMineScope = useCallback(
    (scope: string | undefined) => {
      setSearchParams((prev) => {
        if (scope) prev.set("mineScope", scope)
        else prev.delete("mineScope")
        return prev
      }, { replace: true })
    },
    [setSearchParams]
  )

  const setFilterText = useCallback(
    (text: string) => {
      setSearchParams((prev) => {
        if (text) prev.set("q", text)
        else prev.delete("q")
        return prev
      }, { replace: true })
    },
    [setSearchParams]
  )

  const clearAll = useCallback(() => {
    setSearchParams((prev) => {
      prev.delete("f")
      prev.delete("hot")
      prev.delete("mine")
      prev.delete("review")
      prev.delete("mineScope")
      prev.delete("q")
      prev.delete("from")
      prev.delete("to")
      return prev
    }, { replace: true })
  }, [setSearchParams])

  return {
    state,
    toggleFilter,
    removeFilterKey,
    toggleHot,
    toggleReview,
    toggleMine,
    setMineScope,
    setFilterText,
    clearAll
  } as const
}
