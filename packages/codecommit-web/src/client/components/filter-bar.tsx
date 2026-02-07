import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { SearchIcon, XIcon } from "lucide-react"
import { useMemo } from "react"
import { appStateAtom } from "../atoms/app.js"
import { filterTextAtom, quickFilterAtom, type QuickFilterType } from "../atoms/ui.js"
import { extractScope } from "../utils/extractScope.js"
import { Button } from "./ui/button.js"
import { Input } from "./ui/input.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js"
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.js"

const QUICK_FILTERS: Array<{ key: QuickFilterType; label: string }> = [
  { key: "all", label: "All" },
  { key: "mine", label: "Mine" },
  { key: "account", label: "Account" },
  { key: "author", label: "Author" },
  { key: "scope", label: "Scope" },
  { key: "repo", label: "Repo" },
  { key: "status", label: "Status" }
]

export function FilterBar() {
  const state = useAtomValue(appStateAtom)
  const quickFilter = useAtomValue(quickFilterAtom)
  const setQuickFilter = useAtomSet(quickFilterAtom)
  const filterText = useAtomValue(filterTextAtom)
  const setFilterText = useAtomSet(filterTextAtom)

  const prs = state.pullRequests
  const currentUser = state.currentUser

  const filterOptions = useMemo(() => {
    const authors = new Set<string>()
    const accounts = new Set<string>()
    const scopes = new Set<string>()
    const myScopes = new Set<string>()
    const repos = new Set<string>()

    for (const pr of prs) {
      authors.add(pr.author)
      accounts.add(pr.account?.id ?? "unknown")
      repos.add(pr.repositoryName)
      const scope = extractScope(pr.title)
      if (scope) {
        scopes.add(scope)
        if (currentUser && pr.author === currentUser) {
          myScopes.add(scope)
        }
      }
    }

    return {
      authors: Array.from(authors).sort(),
      accounts: Array.from(accounts).sort(),
      scopes: Array.from(scopes).sort(),
      myScopes: Array.from(myScopes).sort(),
      repos: Array.from(repos).sort()
    }
  }, [prs, currentUser])

  const handleFilterClick = (value: string) => {
    const key = value as QuickFilterType
    if (!key || key === "all") {
      setQuickFilter({ type: "all" })
      return
    }
    const options =
      key === "mine"
        ? filterOptions.myScopes
        : key === "author"
          ? filterOptions.authors
          : key === "account"
            ? filterOptions.accounts
            : key === "scope"
              ? filterOptions.scopes
              : key === "repo"
                ? filterOptions.repos
                : key === "status"
                  ? ["approved", "pending", "mergeable", "conflicts"]
                  : []

    if (options.length > 0 && options[0] !== undefined) {
      setQuickFilter({ type: key, value: options[0] })
    }
  }

  const handleValueChange = (value: string) => {
    if (quickFilter.type !== "all") {
      setQuickFilter({ type: quickFilter.type, value })
    }
  }

  const currentOptions =
    quickFilter.type === "mine"
      ? filterOptions.myScopes
      : quickFilter.type === "author"
        ? filterOptions.authors
        : quickFilter.type === "account"
          ? filterOptions.accounts
          : quickFilter.type === "scope"
            ? filterOptions.scopes
            : quickFilter.type === "repo"
              ? filterOptions.repos
              : quickFilter.type === "status"
                ? ["approved", "pending", "mergeable", "conflicts"]
                : []

  return (
    <div className="border-b bg-background">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={quickFilter.type}
          onValueChange={handleFilterClick}
        >
          {QUICK_FILTERS.map((f) => (
            <ToggleGroupItem key={f.key} value={f.key}>
              {f.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {currentOptions.length > 0 && quickFilter.type !== "all" && quickFilter.value && (
          <Select value={quickFilter.value} onValueChange={handleValueChange}>
            <SelectTrigger size="sm" className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {currentOptions.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="relative ml-auto w-64">
          <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="Search..."
            className="h-8 pl-8"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
          {filterText && (
            <Button variant="ghost" size="icon-xs" className="absolute right-1 top-1" onClick={() => setFilterText("")}>
              <XIcon className="size-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
