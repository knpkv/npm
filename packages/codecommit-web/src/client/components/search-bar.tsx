import { useSearchParams } from "react-router"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { SearchBarView } from "./search-bar-view.js"

export function SearchBar() {
  const { clearAll, setFilterText, state, toggleFilter } = useFilterParams()
  const [, setSearchParams] = useSearchParams()

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
    <SearchBarView
      state={state}
      onSearchChange={setFilterText}
      onToggleFilter={toggleFilter}
      onClearDateRange={clearDateRange}
      onClearAll={clearAll}
    />
  )
}
