import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router"
import type { QuickFilter, QuickFilterType } from "../atoms/ui.js"

const FILTER_TYPES: ReadonlyArray<QuickFilterType> = [
  "all",
  "mine",
  "account",
  "author",
  "scope",
  "repo",
  "status",
  "hot"
]

const isFilterType = (v: string | null): v is QuickFilterType =>
  v !== null && FILTER_TYPES.includes(v as QuickFilterType)

export function useFilterParams() {
  const [searchParams, setSearchParams] = useSearchParams()

  const quickFilter: QuickFilter = useMemo(() => {
    const type = searchParams.get("filter")
    const value = searchParams.get("value") ?? undefined
    if (!isFilterType(type) || type === "all") return { type: "all" }
    return value ? { type, value } : { type }
  }, [searchParams])

  const filterText = searchParams.get("q") ?? ""

  const setQuickFilter = useCallback(
    (f: QuickFilter) => {
      setSearchParams(
        (prev) => {
          if (f.type === "all") {
            prev.delete("filter")
            prev.delete("value")
          } else {
            prev.set("filter", f.type)
            if (f.value) prev.set("value", f.value)
            else prev.delete("value")
          }
          return prev
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const setFilterText = useCallback(
    (text: string) => {
      setSearchParams(
        (prev) => {
          if (text) prev.set("q", text)
          else prev.delete("q")
          return prev
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  return { quickFilter, filterText, setQuickFilter, setFilterText } as const
}
