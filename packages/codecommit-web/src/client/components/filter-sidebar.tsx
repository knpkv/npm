/**
 * Filter sidebar — vertical filter panel for the home page.
 *
 * Renders Hot/Mine/Review toggles and collapsible filter sections
 * (status, author, repo, scope, account, approver, commenter, size)
 * with inline checkbox lists. Cascading options: each section shows
 * values from PRs matching all OTHER active filters.
 *
 * @module
 */
import { useAtomValue } from "@effect-atom/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { CheckIcon, ChevronDownIcon, EyeIcon, FlameIcon, LayoutListIcon, UserIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
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

const VISIBLE_KEYS: ReadonlyArray<FilterKey> = [
  "status",
  "author",
  "repo",
  "scope",
  "account",
  "approver",
  "commenter",
  "size"
]

function extractOptionsFromPRs(prs: ReadonlyArray<PullRequest>, currentUser: string | undefined) {
  const authors = new Set<string>()
  const accounts = new Set<string>()
  const scopes = new Set<string>()
  const repos = new Set<string>()
  const commenters = new Set<string>()
  const approvers = new Set<string>()

  for (const pr of prs) {
    authors.add(pr.author)
    accounts.add(pr.account?.profile ?? "unknown")
    repos.add(pr.repositoryName)
    const scope = extractScope(pr.title)
    if (scope) scopes.add(scope)
    if (pr.commentedBy) {
      for (const n of pr.commentedBy) if (n) commenters.add(n)
    }
    if (pr.approvedBy) {
      for (const n of pr.approvedBy) if (n) approvers.add(n)
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
    size: ["small", "medium", "large", "xlarge"]
  }
}

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

const STATUS_AXIS: Record<string, string> = {
  open: "lifecycle",
  merged: "lifecycle",
  closed: "lifecycle",
  approved: "approval",
  pending: "approval",
  mergeable: "merge",
  conflicts: "merge"
}

// --- Searchable combobox filter ---

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
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-md px-2 py-2.5 text-sm hover:bg-accent transition-colors"
        >
          <span className="flex items-center gap-2">
            {label}
            {count > 0 && (
              <Badge variant="default" className="h-4 min-w-[16px] px-1 text-[10px] rounded-full">
                {count}
              </Badge>
            )}
          </span>
          <ChevronDownIcon className="size-3.5 opacity-40" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" side="right" align="start">
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

// --- Main sidebar ---

export function FilterSidebar() {
  const appState = useAtomValue(appStateAtom)
  const { clearAll, state, toggleFilter } = useFilterParams()
  const [, setSearchParams] = useSearchParams()

  const prs = appState.pullRequests
  const currentUser = appState.currentUser

  // Default to hot mode on initial mount if no mode is set
  // Note: status:open default is handled by parseFilters in useFilterParams (when no f= params)
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const hasAuthorFilter = prev.getAll("f").some((f) => f.startsWith("author:"))
        if (!prev.has("sortBy") && !prev.has("review") && !hasAuthorFilter) {
          prev.set("sortBy", "updated")
        }
        return prev
      },
      { replace: true }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedMap = useMemo(() => {
    const map = new Map<FilterKey, Array<string>>()
    for (const f of state.filters) {
      const arr = map.get(f.key)
      if (arr) arr.push(f.value)
      else map.set(f.key, [f.value])
    }
    return map
  }, [state.filters])

  const handleToggle = useCallback(
    (key: FilterKey, value: string) => {
      if (key === "status" && value === "open") {
        setSearchParams(
          (prev) => {
            let existing = prev.getAll("f")
            if (existing.length === 0) {
              prev.append("f", "status:open")
              existing = prev.getAll("f")
            }
            if (existing.includes("status:open")) {
              prev.delete("f")
              for (const raw of existing) {
                if (raw === "status:open" || raw === "") continue
                prev.append("f", raw)
              }
              if (prev.getAll("f").length === 0) prev.append("f", "")
              return prev
            }
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
      const otherGroups = [...byGroup.entries()].filter(([k]) => k !== key && !k.startsWith(`${key}:`))
      let subset = prs
      if (otherGroups.length > 0) {
        subset = prs.filter((pr) => otherGroups.every(([, group]) => group.some((f) => matchesPR(pr, f))))
      }
      const opts = extractOptionsFromPRs(subset, currentUser)
      result[key] = opts[key] ?? []
    }

    return result as Record<FilterKey, ReadonlyArray<string>>
  }, [prs, currentUser, state.filters])

  const hasDateRange = !!state.from || !!state.to
  const hasAny = state.filters.length > 0 || state.hot || state.review || hasDateRange
  const isMine = currentUser != null && (selectedMap.get("author")?.includes(currentUser) ?? false)
  const isAll = !state.hot && !state.review && !isMine
  const activeMode = state.hot ? "hot" : state.review ? "review" : isMine ? "mine" : "all"

  // Mutually exclusive — clicking already-active mode goes back to Hot
  const switchMode = useCallback(
    (mode: "hot" | "mine" | "review" | "all") => {
      setSearchParams(
        (prev) => {
          // Clear all modes
          prev.delete("sortBy")
          prev.delete("groupBy")
          prev.delete("review")
          const filters = prev.getAll("f").filter((f) => (currentUser ? f !== `author:${currentUser}` : true))
          prev.delete("f")
          for (const f of filters) prev.append("f", f)

          // If clicking already-active mode, fall back to hot
          const target = mode === activeMode ? "hot" : mode

          switch (target) {
            case "hot":
              prev.set("sortBy", "updated")
              break
            case "all":
              prev.set("groupBy", "account")
              break
            case "mine":
              prev.set("groupBy", "account")
              if (currentUser) prev.append("f", `author:${currentUser}`)
              break
            case "review":
              prev.set("review", "1")
              break
          }

          // Ensure status:open default is preserved when explicit f= params exist
          const hasStatusFilter = prev.getAll("f").some((f) => f.startsWith("status:"))
          if (!hasStatusFilter && prev.getAll("f").length > 0) {
            prev.append("f", "status:open")
          }

          return prev
        },
        { replace: true }
      )
    },
    [setSearchParams, currentUser, activeMode]
  )

  return (
    <aside
      className="sticky top-20 flex w-56 shrink-0 flex-col gap-1 self-start overflow-y-auto pb-8"
      style={{ maxHeight: "calc(100vh - 5rem)" }}
    >
      {/* Quick toggles */}
      <div className="flex flex-col gap-1.5">
        <Button
          variant={state.hot ? "default" : "ghost"}
          size="sm"
          className="justify-start gap-2.5 h-9"
          onClick={() => switchMode("hot")}
        >
          <FlameIcon className="size-3.5" />
          Hot
        </Button>

        <Button
          variant={isAll ? "default" : "ghost"}
          size="sm"
          className="justify-start gap-2.5 h-9"
          onClick={() => switchMode("all")}
        >
          <LayoutListIcon className="size-3.5" />
          All
        </Button>

        {currentUser && (
          <Button
            variant={isMine ? "default" : "ghost"}
            size="sm"
            className="justify-start gap-2.5 h-9"
            onClick={() => switchMode("mine")}
          >
            <UserIcon className="size-3.5" />
            Mine
          </Button>
        )}

        {currentUser && (
          <Button
            variant={state.review ? "default" : "ghost"}
            size="sm"
            className="justify-start gap-2.5 h-9"
            onClick={() => switchMode("review")}
          >
            <EyeIcon className="size-3.5" />
            Review
          </Button>
        )}
      </div>

      {/* Filters header */}
      <div className="mt-6 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">Filters</span>
        {hasAny && (
          <button
            type="button"
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            onClick={clearAll}
          >
            Clear all
            <XIcon className="size-2.5" />
          </button>
        )}
      </div>

      <div className="h-px bg-border my-1" />

      {/* Filter sections */}
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
    </aside>
  )
}
