import { useAtomValue } from "@effect-atom/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { CheckIcon, ChevronDownIcon, FlameIcon, SearchIcon, UserIcon, XIcon } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useSearchParams } from "react-router"
import { appStateAtom } from "../atoms/app.js"
import type { FilterEntry, FilterKey } from "../atoms/ui.js"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { extractScope } from "../utils/extractScope.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command.js"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js"

type PullRequest = Domain.PullRequest

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

/** Always-visible filter categories */
const VISIBLE_KEYS: ReadonlyArray<FilterKey> = [
  "author",
  "repo",
  "status",
  "scope",
  "account",
  "approver",
  "commenter",
  "size"
]

type OptionMap = Record<FilterKey, ReadonlyArray<string>>

/** Map of group header → child option values. Header checked = all children checked. */
type OptionGroups = Record<string, ReadonlyArray<string>>

function FilterCombobox({
  filterKey,
  groups,
  label,
  onToggle,
  options,
  selected
}: {
  filterKey: FilterKey
  label: string
  options: ReadonlyArray<string>
  selected: ReadonlyArray<string>
  onToggle: (key: FilterKey, value: string) => void
  groups?: OptionGroups
}) {
  const [open, setOpen] = useState(false)
  const count = selected.length

  const groupChildren = useMemo(() => (groups ? new Set(Object.values(groups).flat()) : new Set<string>()), [groups])
  const childToParent = useMemo(() => {
    if (!groups) return new Map<string, string>()
    const map = new Map<string, string>()
    for (const [g, children] of Object.entries(groups)) {
      for (const c of children) map.set(c, g)
    }
    return map
  }, [groups])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={count > 0 ? "secondary" : "outline"} size="sm" className="h-8 gap-1 text-xs">
          {label}
          {count > 0 && (
            <Badge variant="default" className="ml-0.5 h-4 min-w-[16px] px-1 text-[10px] rounded-full">
              {count}
            </Badge>
          )}
          <ChevronDownIcon className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}...`} />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              {options.map((opt, i) => {
                const isGroup = groups != null && opt in groups
                const isChild = groupChildren.has(opt)
                const parentName = childToParent.get(opt)
                const isSelected = isGroup
                  ? groups![opt]!.every((c) => selected.includes(c)) || selected.includes(opt)
                  : selected.includes(opt) || (parentName != null && selected.includes(parentName))
                // Separator after last child in a group
                const prevOpt = i > 0 ? options[i - 1] : undefined
                const showSep = !isChild && !isGroup && prevOpt != null && groupChildren.has(prevOpt)
                return (
                  <div key={opt}>
                    {showSep && <div className="my-1 h-px bg-border" />}
                    <CommandItem onSelect={() => onToggle(filterKey, opt)} className={isChild ? "pl-8" : ""}>
                      <div
                        className={`mr-2 flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                          isSelected ? "bg-primary border-primary text-primary-foreground" : "opacity-50"
                        }`}
                      >
                        {isSelected && <CheckIcon className="size-3" />}
                      </div>
                      <span className={`truncate ${isGroup ? "font-medium" : ""}`}>{opt}</span>
                    </CommandItem>
                  </div>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function extractOptionsFromPRs(prs: ReadonlyArray<PullRequest>, currentUser: string | undefined) {
  const authors = new Set<string>()
  const accounts = new Set<string>()
  const scopes = new Set<string>()
  const myScopes = new Set<string>()
  const repos = new Set<string>()
  const commenters = new Set<string>()
  const approvers = new Set<string>()

  for (const pr of prs) {
    authors.add(pr.author)
    accounts.add(pr.account?.profile ?? "unknown")
    repos.add(pr.repositoryName)
    const scope = extractScope(pr.title)
    if (scope) {
      scopes.add(scope)
      if (currentUser && pr.author === currentUser) myScopes.add(scope)
    }
    if (pr.commentedBy) {
      for (const n of pr.commentedBy) {
        if (n) commenters.add(n)
      }
    }
    if (pr.approvedBy) {
      for (const n of pr.approvedBy) {
        if (n) approvers.add(n)
      }
    }
  }

  return {
    account: Array.from(accounts).sort(),
    author: Array.from(authors).sort(),
    approver: Array.from(approvers).sort(),
    commenter: Array.from(commenters).sort(),
    scope: Array.from(scopes).sort(),
    repo: Array.from(repos).sort(),
    status: ["open", "approved", "pending", "mergeable", "conflicts", "merged", "closed"],
    size: ["small", "medium", "large", "xlarge"],
    myScopes: Array.from(myScopes).sort()
  }
}

/** Match a single PR against a single filter entry */
function matchesPR(pr: PullRequest, entry: FilterEntry): boolean {
  switch (entry.key) {
    case "account":
      return (pr.account?.profile ?? "unknown") === entry.value
    case "author":
      return pr.author === entry.value
    case "scope":
      return extractScope(pr.title) === entry.value
    case "repo":
      return pr.repositoryName === entry.value
    case "approver":
      return pr.approvedBy?.some((n) => n === entry.value) ?? false
    case "commenter":
      return pr.commentedBy?.some((n) => n === entry.value) ?? false
    case "size": {
      const fc = pr.filesChanged
      if (fc == null) return false
      switch (entry.value) {
        case "small":
          return fc < 5
        case "medium":
          return fc >= 5 && fc <= 15
        case "large":
          return fc >= 16 && fc <= 30
        case "xlarge":
          return fc > 30
        default:
          return true
      }
    }
    case "status":
      switch (entry.value) {
        case "approved":
          return pr.status === "OPEN" && pr.isApproved
        case "pending":
          return pr.status === "OPEN" && !pr.isApproved
        case "mergeable":
          return pr.status === "OPEN" && pr.isMergeable
        case "conflicts":
          return pr.status === "OPEN" && !pr.isMergeable
        case "merged":
          return pr.status === "MERGED"
        case "closed":
          return pr.status === "CLOSED"
        case "open":
          return pr.status === "OPEN"
        default:
          return true
      }
    default:
      return true
  }
}

const OPEN_SUB_STATUSES = ["approved", "pending", "mergeable", "conflicts"] as const

export function FilterBar() {
  const appState = useAtomValue(appStateAtom)
  const { clearAll, setFilterText, state, toggleFilter, toggleHot } = useFilterParams()
  const [, setSearchParams] = useSearchParams()

  const setDateRange = useCallback(
    (from: string | undefined, to: string | undefined) => {
      setSearchParams(
        (prev) => {
          if (from) prev.set("from", from)
          else prev.delete("from")
          if (to) prev.set("to", to)
          else prev.delete("to")
          return prev
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const prs = appState.pullRequests
  const currentUser = appState.currentUser

  // Selected values grouped by key (moved above handleToggle so it can reference it)
  const selectedMap = useMemo(() => {
    const map = new Map<FilterKey, Array<string>>()
    for (const f of state.filters) {
      const arr = map.get(f.key)
      if (arr) arr.push(f.value)
      else map.set(f.key, [f.value])
    }
    return map
  }, [state.filters])

  // Status group toggle with parent-expansion awareness
  const handleToggle = useCallback(
    (key: FilterKey, value: string) => {
      if (key === "status" && value === "open") {
        // Clicking the "open" group header
        setSearchParams(
          (prev) => {
            let existing = prev.getAll("f")
            // Materialize defaults if needed
            if (existing.length === 0) {
              prev.append("f", "status:open")
              existing = prev.getAll("f")
            }
            // If "open" is directly selected, toggle it off
            if (existing.includes("status:open")) {
              prev.delete("f")
              for (const raw of existing) {
                if (raw === "status:open" || raw === "") continue
                prev.append("f", raw)
              }
              if (prev.getAll("f").length === 0) prev.append("f", "")
              return prev
            }
            // Otherwise, group expansion (toggle all sub-statuses).
            // Strip lifecycle peers (merged/closed) to avoid contradictory cross-axis combos.
            const subs = OPEN_SUB_STATUSES.map((s) => `status:${s}`)
            const lifecycle = new Set(["status:merged", "status:closed"])
            const allPresent = subs.every((s) => existing.includes(s))
            prev.delete("f")
            for (const raw of existing) {
              if (subs.includes(raw as (typeof subs)[number]) || lifecycle.has(raw)) continue
              prev.append("f", raw)
            }
            if (!allPresent) {
              for (const s of subs) prev.append("f", s)
            }
            if (prev.getAll("f").length === 0) prev.append("f", "")
            return prev
          },
          { replace: true }
        )
      } else if (
        key === "status" &&
        (OPEN_SUB_STATUSES as ReadonlyArray<string>).includes(value) &&
        selectedMap.get("status")?.includes("open")
      ) {
        // Clicking a sub-status while parent "open" is directly selected:
        // expand parent into all sub-statuses minus the clicked one
        setSearchParams(
          (prev) => {
            let existing = prev.getAll("f")
            if (existing.length === 0) {
              prev.append("f", "status:open")
              existing = prev.getAll("f")
            }
            prev.delete("f")
            for (const raw of existing) {
              if (raw === "status:open" || raw === "") continue
              prev.append("f", raw)
            }
            for (const s of OPEN_SUB_STATUSES) {
              if (s !== value) prev.append("f", `status:${s}`)
            }
            return prev
          },
          { replace: true }
        )
      } else {
        toggleFilter(key, value)
      }
    },
    [toggleFilter, setSearchParams, selectedMap]
  )

  // Cascading options: for each filter key, compute available options
  // from PRs that match all OTHER active filter groups.
  // Status uses axis-based sub-grouping (same as pr-list filtering).
  const STATUS_AXIS: Record<string, string> = {
    open: "lifecycle",
    merged: "lifecycle",
    closed: "lifecycle",
    approved: "approval",
    pending: "approval",
    mergeable: "merge",
    conflicts: "merge"
  }
  const cascadedOptions = useMemo(() => {
    const byGroup = new Map<string, ReadonlyArray<FilterEntry>>()
    for (const f of state.filters) {
      const groupKey = f.key === "status" ? `status:${STATUS_AXIS[f.value] ?? f.value}` : f.key
      const arr = byGroup.get(groupKey)
      if (arr) (arr as Array<FilterEntry>).push(f)
      else byGroup.set(groupKey, [f])
    }

    const result: Record<string, ReadonlyArray<string>> = {}

    for (const key of VISIBLE_KEYS) {
      // Filter PRs by all groups EXCEPT ones belonging to the current key
      const otherGroups = [...byGroup.entries()].filter(([k]) => k !== key && !k.startsWith(`${key}:`))
      let subset = prs
      if (otherGroups.length > 0) {
        subset = prs.filter((pr) => otherGroups.every(([, group]) => group.some((f) => matchesPR(pr, f))))
      }
      const opts = extractOptionsFromPRs(subset, currentUser)
      result[key] = opts[key] ?? []
    }

    return result as OptionMap
  }, [prs, currentUser, state.filters])

  const hasDateRange = !!state.from || !!state.to
  const hasAny = state.filters.length > 0 || state.hot || state.q || hasDateRange

  const hasChips = state.filters.length > 0

  return (
    <div className="border-b bg-background">
      {/* Row 1: Toggles + filter dropdowns */}
      <div className="mx-auto flex max-w-5xl items-center gap-1.5 px-4 pt-2 pb-1 flex-wrap">
        <Button variant={state.hot ? "default" : "outline"} size="sm" className="gap-1 h-7" onClick={toggleHot}>
          <FlameIcon className="size-3.5" />
          Hot
        </Button>

        {currentUser && (
          <Button
            variant={selectedMap.get("author")?.includes(currentUser) ? "default" : "outline"}
            size="sm"
            className="gap-1 h-7"
            onClick={() => handleToggle("author", currentUser)}
          >
            <UserIcon className="size-3.5" />
            Mine
          </Button>
        )}

        <div className="mx-0.5 h-4 w-px bg-border" />

        {VISIBLE_KEYS.map((key) => (
          <FilterCombobox
            key={key}
            filterKey={key}
            label={FILTER_LABELS[key]}
            options={cascadedOptions[key]}
            selected={selectedMap.get(key) ?? []}
            onToggle={handleToggle}
            {...(key === "status" ? { groups: { open: OPEN_SUB_STATUSES as unknown as Array<string> } } : {})}
          />
        ))}
      </div>

      {/* Row 2: Full-width search bar with inline filter tags */}
      <div className="mx-auto max-w-5xl px-4 pb-2">
        <div className="flex items-center gap-1.5 rounded-md border bg-background px-3 min-h-[44px] focus-within:ring-1 focus-within:ring-ring flex-wrap py-1.5">
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
            <Badge
              variant="outline"
              className="cursor-pointer gap-1 pl-2 pr-0.5 h-5 text-[10px] shrink-0"
              onClick={() => setDateRange(undefined, undefined)}
            >
              {state.from} → {state.to}
              <XIcon className="size-2.5" />
            </Badge>
          )}

          <input
            placeholder={hasChips || hasDateRange ? "Refine..." : "Search PRs..."}
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
      </div>
    </div>
  )
}
