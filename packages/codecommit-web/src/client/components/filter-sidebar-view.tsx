import { Button, Text } from "@knpkv/rly/primitives"
import { ChevronDownIcon } from "lucide-react"
import { useMemo, useState } from "react"
import type { FilterKey, FilterState } from "../atoms/ui.js"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command.js"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js"
import styles from "./review-queue.module.css"
import { FilterSelectionIndicator } from "./filter-selection-indicator.js"
import { filterLabels, openSubStatuses, resolveQueueMode, type QueueMode } from "./review-queue-state.js"

export interface FilterSidebarViewProps {
  readonly state: FilterState
  readonly currentUser: string | undefined
  readonly options: Readonly<Record<FilterKey, ReadonlyArray<string>>>
  readonly onToggleOption: (key: FilterKey, value: string) => void
  readonly onModeChange: (mode: QueueMode) => void
  readonly onClearAll: () => void
}

export const visibleKeys: ReadonlyArray<FilterKey> = [
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

function FilterCombobox({ filterKey, groups, label, onToggle, options, selected }: FilterComboboxProps) {
  const [open, setOpen] = useState(false)
  const count = selected.length
  const groupChildren = useMemo(() => new Set(groups !== undefined ? Object.values(groups).flat() : []), [groups])
  const childToParent = useMemo(() => {
    const map = new Map<string, string>()
    if (groups !== undefined) {
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

/** Queue modes and grouped options; cascading data and URL semantics remain with the caller. */
export function FilterSidebarView({
  currentUser,
  onClearAll,
  onModeChange,
  onToggleOption,
  options,
  state
}: FilterSidebarViewProps) {
  const selectedMap = useMemo(() => {
    const map = new Map<FilterKey, Array<string>>()
    for (const filter of state.filters) {
      const selected = map.get(filter.key)
      if (selected !== undefined) selected.push(filter.value)
      else map.set(filter.key, [filter.value])
    }
    return map
  }, [state.filters])

  const activeMode = resolveQueueMode(state, currentUser)
  const hasAny =
    state.filters.length > 0 || state.hot || state.review || state.q.length > 0 || Boolean(state.from || state.to)

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
              onClick={() => onModeChange(mode.id)}
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
            onToggle={onToggleOption}
            options={options[key]}
            selected={selectedMap.get(key) ?? []}
            {...(key === "status" ? { groups: { open: [...openSubStatuses] } } : {})}
          />
        ))}
      </div>

      {hasAny ? (
        <Button className={styles.clearFilters} onClick={onClearAll} size="compact" variant="quiet">
          Reset view
        </Button>
      ) : null}
    </section>
  )
}
