import { SearchIcon, XIcon } from "lucide-react"
import { useMemo } from "react"
import type { FilterKey } from "../atoms/ui.js"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { Badge } from "./ui/badge.js"

const FILTER_LABELS: Record<FilterKey, string> = {
  account: "Account",
  author: "Author",
  approver: "Approver",
  commenter: "Commenter",
  scope: "Scope",
  repo: "Repo",
  status: "Status",
  size: "Size"
}

export function SearchBar() {
  const { clearAll, setFilterText, state, toggleFilter } = useFilterParams()

  const selectedMap = useMemo(() => {
    const map = new Map<FilterKey, Array<string>>()
    for (const f of state.filters) {
      const arr = map.get(f.key)
      if (arr) arr.push(f.value)
      else map.set(f.key, [f.value])
    }
    return map
  }, [state.filters])

  const hasDateRange = !!state.from || !!state.to
  const hasAny = state.filters.length > 0 || state.review || state.q || hasDateRange
  const hasChips = state.filters.length > 0

  return (
    <div className="flex items-center gap-1.5 rounded-lg border bg-background px-3 min-h-[44px] focus-within:ring-1 focus-within:ring-ring flex-wrap py-1.5">
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" />

      {[...selectedMap.entries()].map(([key, values]) =>
        values.map((value) => (
          <Badge
            key={`${key}:${value}`}
            variant="secondary"
            className="cursor-pointer gap-1 pl-2 pr-0.5 h-5 text-[10px] shrink-0"
            onClick={() => toggleFilter(key, value)}
          >
            {FILTER_LABELS[key]}: {value}
            <XIcon className="size-2.5" />
          </Badge>
        ))
      )}

      {hasDateRange && (
        <Badge variant="outline" className="cursor-pointer gap-1 pl-2 pr-0.5 h-5 text-[10px] shrink-0">
          {state.from} → {state.to}
          <XIcon className="size-2.5" />
        </Badge>
      )}

      <input
        placeholder={hasChips || hasDateRange ? "Refine..." : "Search commits..."}
        className="flex-1 min-w-[80px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        value={state.q}
        onChange={(e) => setFilterText(e.target.value)}
      />

      {hasAny && (
        <button
          type="button"
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          onClick={clearAll}
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}
