import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router"
import { FILTER_KEYS, type FilterEntry, type FilterKey, type FilterState } from "../atoms/ui.js"

const isFilterKey = (k: string): k is FilterKey => (FILTER_KEYS as ReadonlyArray<string>).includes(k)

function parseFilters(params: URLSearchParams): ReadonlyArray<FilterEntry> {
  const entries: Array<FilterEntry> = []
  for (const raw of params.getAll("f")) {
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
        const existing = prev.getAll("f")
        const target = `${key}:${value}`
        const has = existing.includes(target)
        prev.delete("f")
        for (const raw of existing) {
          if (raw === target) continue // skip — we'll either remove or re-add
          prev.append("f", raw)
        }
        if (!has) prev.append("f", target)
        return prev
      }, { replace: true })
    },
    [setSearchParams]
  )

  /** Remove all values for a given key */
  const removeFilterKey = useCallback(
    (key: FilterKey) => {
      setSearchParams((prev) => {
        const existing = prev.getAll("f")
        prev.delete("f")
        for (const raw of existing) {
          const k = raw.slice(0, raw.indexOf(":"))
          if (k !== key) prev.append("f", raw)
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
      prev.delete("mineScope")
      prev.delete("q")
      prev.delete("from")
      prev.delete("to")
      return prev
    }, { replace: true })
  }, [setSearchParams])

  return { state, toggleFilter, removeFilterKey, toggleHot, toggleMine, setMineScope, setFilterText, clearAll } as const
}
