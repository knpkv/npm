import { useAtomValue, useAtomSet } from "@effect-atom/atom-react"
import { useMemo } from "react"
import { Chunk } from "effect"
import { prsQueryAtom } from "../../atoms/app.js"
import { filterTextAtom, quickFilterAtom, type QuickFilterType } from "../../atoms/ui.js"
import { useTheme } from "../../theme/index.js"
import { extractScope } from "../../utils/extractScope.js"
import styles from "./FilterBar.module.css"

const QUICK_FILTERS: { key: QuickFilterType; label: string; shortcut: string }[] = [
  { key: "all", label: "All", shortcut: "1" },
  { key: "mine", label: "Mine", shortcut: "2" },
  { key: "account", label: "Acct", shortcut: "3" },
  { key: "author", label: "Auth", shortcut: "4" },
  { key: "scope", label: "Scope", shortcut: "5" },
  { key: "repo", label: "Repo", shortcut: "6" },
  { key: "status", label: "Status", shortcut: "7" },
]

export function FilterBar() {
  const { theme } = useTheme()
  const prsResult = useAtomValue(prsQueryAtom)
  const quickFilter = useAtomValue(quickFilterAtom)
  const setQuickFilter = useAtomSet(quickFilterAtom)
  const filterText = useAtomValue(filterTextAtom)
  const setFilterText = useAtomSet(filterTextAtom)

  const prs = useMemo(() => {
    if (prsResult._tag === "Success") {
      return Chunk.toArray(prsResult.value)
    }
    return []
  }, [prsResult])

  // Extract unique values for dropdown filters
  const filterOptions = useMemo(() => {
    const authors = new Set<string>()
    const accounts = new Set<string>()
    const scopes = new Set<string>()
    const repos = new Set<string>()

    for (const pr of prs) {
      authors.add(pr.author)
      accounts.add(pr.account?.id ?? "unknown")
      repos.add(pr.repositoryName)
      const scope = extractScope(pr.title)
      if (scope) scopes.add(scope)
    }

    return {
      authors: Array.from(authors).sort(),
      accounts: Array.from(accounts).sort(),
      scopes: Array.from(scopes).sort(),
      repos: Array.from(repos).sort(),
    }
  }, [prs])

  const handleFilterClick = (key: QuickFilterType) => {
    if (key === "all") {
      setQuickFilter({ type: "all" })
    } else if (key === quickFilter.type) {
      // Toggle off
      setQuickFilter({ type: "all" })
    } else {
      // For filters that need a value, show first option
      const options = key === "author" ? filterOptions.authors
        : key === "account" ? filterOptions.accounts
        : key === "scope" ? filterOptions.scopes
        : key === "repo" ? filterOptions.repos
        : key === "status" ? ["approved", "pending", "mergeable", "conflicts"]
        : []

      if (options.length > 0 && options[0] !== undefined) {
        setQuickFilter({ type: key, value: options[0] })
      }
    }
  }

  const handleValueChange = (value: string) => {
    if (quickFilter.type !== "all" && quickFilter.type !== "mine") {
      setQuickFilter({ type: quickFilter.type, value })
    }
  }

  const currentOptions = quickFilter.type === "author" ? filterOptions.authors
    : quickFilter.type === "account" ? filterOptions.accounts
    : quickFilter.type === "scope" ? filterOptions.scopes
    : quickFilter.type === "repo" ? filterOptions.repos
    : quickFilter.type === "status" ? ["approved", "pending", "mergeable", "conflicts"]
    : []

  return (
    <div className={styles.filterBar} style={{ backgroundColor: theme.backgroundElement }}>
      <div className={styles.quickFilters}>
        {QUICK_FILTERS.map(({ key, label, shortcut }) => (
          <button
            key={key}
            className={`${styles.filterButton} ${quickFilter.type === key ? styles.active : ""}`}
            style={{
              backgroundColor: quickFilter.type === key ? theme.primary : "transparent",
              color: quickFilter.type === key ? theme.background : theme.text,
              borderColor: theme.textMuted,
            }}
            onClick={() => handleFilterClick(key)}
          >
            <span className={styles.shortcut}>[{shortcut}]</span> {label}
          </button>
        ))}
      </div>

      {currentOptions.length > 0 && quickFilter.type !== "all" && (
        <select
          className={styles.valueSelect}
          style={{
            backgroundColor: theme.backgroundPanel,
            color: theme.text,
            borderColor: theme.textMuted,
          }}
          value={quickFilter.value ?? ""}
          onChange={(e) => handleValueChange(e.target.value)}
        >
          {currentOptions.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )}

      <div className={styles.textFilter}>
        <input
          type="text"
          placeholder="Filter by text... (Ctrl+F)"
          className={styles.filterInput}
          style={{
            backgroundColor: theme.backgroundPanel,
            color: theme.text,
            borderColor: theme.textMuted,
          }}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        {filterText && (
          <button
            className={styles.clearButton}
            style={{ color: theme.textMuted }}
            onClick={() => setFilterText("")}
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}
