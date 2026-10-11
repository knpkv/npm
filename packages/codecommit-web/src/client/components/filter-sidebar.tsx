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
import { useCallback, useEffect, useMemo } from "react"
import { useSearchParams } from "react-router"
import { queuePullRequests } from "../utils/queuePullRequests.js"
import { appStateAtom } from "../atoms/app.js"
import type { FilterKey } from "../atoms/ui.js"
import { useFilterParams } from "../hooks/useFilterParams.js"
import { FilterSidebarView, visibleKeys } from "./filter-sidebar-view.js"
import {
  groupQueueFilters,
  matchesQueueFilter,
  openSubStatuses,
  queueFilterOptions,
  resolveQueueMode,
  type QueueMode
} from "./review-queue-state.js"

interface FilterOptions extends Record<FilterKey, ReadonlyArray<string>> {}

export function FilterSidebar() {
  const appState = useAtomValue(appStateAtom)
  const { clearAll, state, toggleFilter } = useFilterParams()
  const [, setSearchParams] = useSearchParams()
  // Facets describe the queue, so a switched-off account must not appear as a
  // filter option.
  const prs = useMemo(() => queuePullRequests(appState), [appState.enabledProfiles, appState.pullRequests])
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
      if (selected !== undefined) selected.push(filter.value)
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
      } else if (
        key === "status" &&
        openSubStatuses.has(value) &&
        selectedMap.get("status")?.includes("open") === true
      ) {
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

    const emptyValues = (): ReadonlyArray<string> => []
    const result: FilterOptions = {
      account: emptyValues(),
      author: emptyValues(),
      approver: emptyValues(),
      commenter: emptyValues(),
      scope: emptyValues(),
      repo: emptyValues(),
      status: emptyValues(),
      size: emptyValues()
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
  const switchMode = useCallback(
    (mode: QueueMode) => {
      setSearchParams(
        (previous) => {
          previous.delete("sortBy")
          previous.delete("groupBy")
          previous.delete("review")
          const filters = previous
            .getAll("f")
            .filter((filter) =>
              currentUser !== undefined && currentUser.length > 0 ? filter !== `author:${currentUser}` : true
            )
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
              if (currentUser !== undefined && currentUser.length > 0) previous.append("f", `author:${currentUser}`)
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

  return (
    <FilterSidebarView
      state={state}
      currentUser={currentUser}
      options={cascadedOptions}
      onToggleOption={handleToggle}
      onModeChange={switchMode}
      onClearAll={clearAll}
    />
  )
}
