/**
 * URL-backed queue view and structured-filter controls.
 *
 * The former sidebar is intentionally presented as a wrapping toolbar so the
 * queue remains the dominant page surface. Cascading options continue to be
 * computed from pull requests matching every other active filter group.
 *
 * @module
 */
import { useAtomValue } from "@effect/atom-react"
import { Button, Text } from "@knpkv/rly/primitives"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router"
import { appStateAtom } from "../atoms/app.js"
import type { FilterKey } from "../atoms/ui.js"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command.js"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js"
import styles from "./review-queue.module.css"
import {
  filterLabels,
  groupQueueFilters,
  matchesQueueFilter,
  openSubStatuses,
  queueFilterOptions,
  resolveQueueMode,
  type QueueMode
} from "./review-queue-state.js"

const visibleKeys: ReadonlyArray<FilterKey> = [
  "status",
  "author",
  "repo",
  "scope",
  "account",
  "approver",
  "commenter",
  "size"
]

type OptionGroups = Readonly<Record<string, ReadonlyArray<string>>>

interface FilterComboboxProps {
  readonly filterKey: FilterKey
  readonly groups?: OptionGroups
  readonly label: string
  readonly onToggle: (key: FilterKey, value: string) => void
  readonly options: ReadonlyArray<string>
  readonly selected: ReadonlyArray<string>
}

export function FilterSelectionIndicator({ selected }: { readonly selected: boolean }) {
  return (
    <>
      <span aria-hidden="true" className={styles.optionCheck} data-selected={selected ? "true" : undefined}>
        {selected ? <CheckIcon /> : null}
      </span>
      <span className={styles.visuallyHidden}>{selected ? "Selected" : "Not selected"}</span>
    </>
  )
}

function FilterCombobox({ filterKey, groups, label, onToggle, options, selected }: FilterComboboxProps) {
  const [open, setOpen] = useState(false)
  const count = selected.length
  const groupChildren = useMemo(() => new Set(groups ? Object.values(groups).flat() : []), [groups])
  const childToParent = useMemo(() => {
    const map = new Map<string, string>()
    if (groups) {
      for (const [group, children] of Object.entries(groups)) {
        for (const child of children) map.set(child, group)
      }
    }
    return map
  }, [groups])

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button className={styles.filterTrigger} data-active={count > 0 ? "true" : undefined} type="button">
          <span>{label}</span>
          {count > 0 ? <span className={styles.filterCount}>{count}</span> : null}
          <ChevronDownIcon aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={styles.filterPopover} side="bottom">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>No matching options.</CommandEmpty>
            <CommandGroup>
              {options.map((option, index) => {
                const isGroup = groups !== undefined && option in groups
                const isChild = groupChildren.has(option)
                const parentName = childToParent.get(option)
                const isSelected = isGroup
                  ? (groups[option]?.every((child) => selected.includes(child)) ?? false) || selected.includes(option)
                  : selected.includes(option) || (parentName !== undefined && selected.includes(parentName))
                const previousOption = index > 0 ? options[index - 1] : undefined
                const showSeparator =
                  !isChild && !isGroup && previousOption !== undefined && groupChildren.has(previousOption)

                return (
                  <div key={option}>
                    {showSeparator ? <div className={styles.commandSeparator} /> : null}
                    <CommandItem
                      className={isChild ? styles.childOption : undefined}
                      onSelect={() => onToggle(filterKey, option)}
                    >
                      <FilterSelectionIndicator selected={isSelected} />
                      <span className={isGroup ? styles.groupOption : undefined}>{option}</span>
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

export function FilterSidebar() {
  const appState = useAtomValue(appStateAtom)
  const { clearAll, state, toggleFilter } = useFilterParams()
  const [, setSearchParams] = useSearchParams()
  const prs = appState.pullRequests
  const currentUser = appState.currentUser

  useEffect(() => {
    setSearchParams(
      (previous) => {
        const hasAuthorFilter = previous.getAll("f").some((filter) => filter.startsWith("author:"))
        if (!previous.has("sortBy") && !previous.has("groupBy") && !previous.has("review") && !hasAuthorFilter) {
          previous.set("sortBy", "updated")
        }
        return previous
      },
      { preventScrollReset: true, replace: true }
    )
  }, [setSearchParams])

  const selectedMap = useMemo(() => {
    const map = new Map<FilterKey, Array<string>>()
    for (const filter of state.filters) {
      const selected = map.get(filter.key)
      if (selected) selected.push(filter.value)
      else map.set(filter.key, [filter.value])
    }
    return map
  }, [state.filters])

  const handleToggle = useCallback(
    (key: FilterKey, value: string) => {
      if (key === "status" && value === "open") {
        setSearchParams(
          (previous) => {
            let existing = previous.getAll("f")
            if (existing.length === 0) {
              previous.append("f", "status:open")
              existing = previous.getAll("f")
            }
            if (existing.includes("status:open")) {
              previous.delete("f")
              for (const raw of existing) {
                if (raw === "status:open" || raw === "") continue
                previous.append("f", raw)
              }
              if (previous.getAll("f").length === 0) previous.append("f", "")
              return previous
            }

            const subStatuses = [...openSubStatuses].map((status) => `status:${status}`)
            const lifecycle = new Set(["status:merged", "status:closed"])
            const allPresent = subStatuses.every((status) => existing.includes(status))
            previous.delete("f")
            for (const raw of existing) {
              if (subStatuses.includes(raw) || lifecycle.has(raw)) continue
              previous.append("f", raw)
            }
            if (!allPresent) for (const status of subStatuses) previous.append("f", status)
            if (previous.getAll("f").length === 0) previous.append("f", "")
            return previous
          },
          { preventScrollReset: true, replace: true }
        )
      } else if (key === "status" && openSubStatuses.has(value) && selectedMap.get("status")?.includes("open")) {
        setSearchParams(
          (previous) => {
            let existing = previous.getAll("f")
            if (existing.length === 0) {
              previous.append("f", "status:open")
              existing = previous.getAll("f")
            }
            previous.delete("f")
            for (const raw of existing) {
              if (raw === "status:open" || raw === "") continue
              previous.append("f", raw)
            }
            for (const status of openSubStatuses) {
              if (status !== value) previous.append("f", `status:${status}`)
            }
            return previous
          },
          { preventScrollReset: true, replace: true }
        )
      } else {
        toggleFilter(key, value)
      }
    },
    [selectedMap, setSearchParams, toggleFilter]
  )

  const cascadedOptions = useMemo(() => {
    const byGroup = groupQueueFilters(state.filters)

    const result: Record<FilterKey, ReadonlyArray<string>> = {
      account: [],
      author: [],
      approver: [],
      commenter: [],
      scope: [],
      repo: [],
      status: [],
      size: []
    }
    for (const key of visibleKeys) {
      const otherGroups = [...byGroup.entries()].filter(
        ([groupKey]) => groupKey !== key && !groupKey.startsWith(`${key}:`)
      )
      const subset =
        otherGroups.length === 0
          ? prs
          : prs.filter((pr) => otherGroups.every(([, group]) => group.some((filter) => matchesQueueFilter(pr, filter))))
      result[key] = queueFilterOptions(subset)[key]
    }
    return result
  }, [prs, state.filters])

  const activeMode = resolveQueueMode(state, currentUser)
  const hasAny =
    state.filters.length > 0 || state.hot || state.review || state.q.length > 0 || Boolean(state.from || state.to)

  const switchMode = useCallback(
    (mode: QueueMode) => {
      setSearchParams(
        (previous) => {
          previous.delete("sortBy")
          previous.delete("groupBy")
          previous.delete("review")
          const filters = previous
            .getAll("f")
            .filter((filter) => (currentUser ? filter !== `author:${currentUser}` : true))
          previous.delete("f")
          for (const filter of filters) previous.append("f", filter)

          const target = mode === activeMode ? "hot" : mode
          switch (target) {
            case "hot":
              previous.set("sortBy", "updated")
              break
            case "all":
              previous.set("groupBy", "account")
              break
            case "mine":
              previous.set("groupBy", "account")
              if (currentUser) previous.append("f", `author:${currentUser}`)
              break
            case "review":
              previous.set("review", "1")
              break
          }

          const hasStatusFilter = previous.getAll("f").some((filter) => filter.startsWith("status:"))
          if (!hasStatusFilter && previous.getAll("f").length > 0) previous.append("f", "status:open")
          return previous
        },
        { preventScrollReset: true, replace: true }
      )
    },
    [activeMode, currentUser, setSearchParams]
  )

  const modes: ReadonlyArray<{ readonly id: QueueMode; readonly label: string; readonly visible: boolean }> = [
    { id: "hot", label: "Hot", visible: true },
    { id: "all", label: "All", visible: true },
    { id: "mine", label: "Mine", visible: currentUser !== undefined },
    { id: "review", label: "Review", visible: currentUser !== undefined }
  ]

  return (
    <section aria-label="Queue views and filters" className={styles.filterPanel}>
      <div className={styles.modeGroup} role="group" aria-label="Queue view">
        {modes
          .filter((mode) => mode.visible)
          .map((mode) => (
            <Button
              aria-pressed={activeMode === mode.id}
              className={styles.modeButton}
              key={mode.id}
              onClick={() => switchMode(mode.id)}
              size="compact"
              variant={activeMode === mode.id ? "primary" : "quiet"}
            >
              {mode.label}
            </Button>
          ))}
      </div>

      <div className={styles.structuredFilters}>
        <Text className={styles.filterLegend} tone="tertiary" variant="meta">
          Filter by
        </Text>
        {visibleKeys.map((key) => (
          <FilterCombobox
            filterKey={key}
            key={key}
            label={filterLabels[key]}
            onToggle={handleToggle}
            options={cascadedOptions[key]}
            selected={selectedMap.get(key) ?? []}
            {...(key === "status" ? { groups: { open: [...openSubStatuses] } } : {})}
          />
        ))}
      </div>

      {hasAny ? (
        <Button className={styles.clearFilters} onClick={clearAll} size="compact" variant="quiet">
          Reset view
        </Button>
      ) : null}
    </section>
  )
}
