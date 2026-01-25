import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { type ScrollBoxRenderable } from "@opentui/core"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { PullRequest } from "../@knpkv/codecommit-core/Domain"
import { type AppState, appStateAtom, notificationsAtom, toggleAccountAtom } from "../atoms/app.js"
import {
  currentPRAtom,
  currentUserAtom,
  filterTextAtom,
  quickFilterTypeAtom,
  quickFilterValuesAtom,
  selectedIndexAtom,
  selectedPrIdAtom,
  settingsFilterAtom,
  viewAtom
} from "../atoms/ui.js"
import { useTheme } from "../context/theme.js"
import { useListNavigation } from "../hooks/useListNavigation.js"
import { type ListItem, buildListItems } from "../ListBuilder.js"
import { NotificationsTable } from "./NotificationsTable.js"
import { ListItemRow } from "./ListItemRow.js"
import { SettingsTable } from "./SettingsTable.js"

const defaultState: AppState = {
  status: "loading",
  pullRequests: [],
  accounts: []
}

interface MainListProps {
  readonly onSelectPR?: (pr: PullRequest) => void
}

/**
 * Main list component showing PRs, settings, or errors based on view
 * @category components
 */
export function MainList({ onSelectPR }: MainListProps) {
  const { theme } = useTheme()
  const result = useAtomValue(appStateAtom)
  const notificationsResult = useAtomValue(notificationsAtom)
  const view = useAtomValue(viewAtom)
  const setView = useAtomSet(viewAtom)
  const filterText = useAtomValue(filterTextAtom)
  const selectedIndex = useAtomValue(selectedIndexAtom)
  const setCurrentPR = useAtomSet(currentPRAtom)
  const toggleAccount = useAtomSet(toggleAccountAtom)

  const scrollRef = useRef<ScrollBoxRenderable>(null)

  const selectedPrId = useAtomValue(selectedPrIdAtom)
  const setSelectedPrId = useAtomSet(selectedPrIdAtom)
  const quickFilterType = useAtomValue(quickFilterTypeAtom)
  const quickFilterValues = useAtomValue(quickFilterValuesAtom)
  const quickFilterValue = quickFilterValues[quickFilterType]
  const currentUser = useAtomValue(currentUserAtom)
  const settingsFilter = useAtomValue(settingsFilterAtom)

  // Preserve previous state during loading to avoid flash
  const [cachedState, setCachedState] = useState<AppState>(defaultState)
  useEffect(() => {
    if (Result.isSuccess(result)) {
      setCachedState(result.value)
    }
  }, [result])
  const state = Result.isSuccess(result) ? result.value : cachedState
  const notifications = Result.getOrElse(notificationsResult, () => ({ items: [] }))

  const quickFilter = useMemo(
    () => ({ type: quickFilterType, value: quickFilterValue, currentUser }),
    [quickFilterType, quickFilterValue, currentUser]
  )

  const rawItems = useMemo(
    () => buildListItems(state, view, filterText, notifications.items, quickFilter),
    [state, view, filterText, notifications.items, quickFilter]
  )

  // Filter settings items by profile name and status (on:/off: prefix)
  const items = useMemo(() => {
    if (view !== "settings" || !settingsFilter) return rawItems
    const filterLower = settingsFilter.toLowerCase()

    // Parse filter: "on:" = enabled only, "off:" = disabled only
    let statusFilter: "all" | "on" | "off" = "all"
    let nameFilter = filterLower
    if (filterLower.startsWith("on:")) {
      statusFilter = "on"
      nameFilter = filterLower.slice(3)
    } else if (filterLower.startsWith("off:")) {
      statusFilter = "off"
      nameFilter = filterLower.slice(4)
    }

    return rawItems.filter((item) => {
      if (item.type !== "account") return false
      // Status filter
      if (statusFilter === "on" && !item.account.enabled) return false
      if (statusFilter === "off" && item.account.enabled) return false
      // Name filter
      if (nameFilter && !item.account.profile.toLowerCase().includes(nameFilter)) return false
      return true
    })
  }, [rawItems, view, settingsFilter])

  // Compute stable index: find PR by ID (for both prs and details view)
  const stableIndex = useMemo(() => {
    if ((view === "prs" || view === "details") && selectedPrId) {
      const idx = items.findIndex((item) => item.type === "pr" && item.pr.id === selectedPrId)
      if (idx !== -1) return idx
    }
    // Clamp to valid range
    if (selectedIndex >= items.length) return Math.max(0, items.length - 1)
    if (selectedIndex < 0) return 0
    return selectedIndex
  }, [items, selectedPrId, selectedIndex, view])

  const currentGroupHeader = useMemo(() => {
    if (items.length === 0) return null
    let index = stableIndex
    if (index >= items.length) index = items.length - 1
    if (index < 0) return null

    for (let i = index; i >= 0; i--) {
      const item = items[i]
      if (item && item.type === "header") return item
    }
    return null
  }, [items, stableIndex])

  // Handle navigation & selection sync
  useListNavigation(
    items,
    () => {
      const item = items[stableIndex]
      if (item?.type === "pr" && onSelectPR) {
        onSelectPR(item.pr)
      } else if (item?.type === "account") {
        setView("prs")
      }
    },
    () => {
      const item = items[stableIndex]
      if (item?.type === "account") {
        toggleAccount(item.account.profile)
      }
    }
  )

  // Compute current PR synchronously to avoid flash in details view
  const currentPR = useMemo(() => {
    const item = items[stableIndex]
    return item?.type === "pr" ? item.pr : null
  }, [items, stableIndex])

  // Sync currentPR atom (for other components) and selectedPrId
  // Don't update when in details view to avoid jumping
  useEffect(() => {
    if (view === "details") return
    setCurrentPR(currentPR)
    if (currentPR && currentPR.id !== selectedPrId) {
      setSelectedPrId(currentPR.id)
    }
  }, [currentPR, setCurrentPR, setSelectedPrId, selectedPrId, view])

  // Calculate item heights for scroll positioning
  const itemPositions = useMemo(() => {
    const positions: { start: number; end: number }[] = []
    let y = 0
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item) continue
      const start = y
      let height = 2
      if (item.type === "header") {
        height = i === 0 ? 2 : 3
      } else if (item.type === "pr") {
        const lines = item.pr.description ? Math.min(item.pr.description.split("\n").length, 5) : 0
        height = 1 + 1 + lines + 1 + 1
      }
      y += height
      positions.push({ start, end: y })
    }
    return positions
  }, [items])

  // Scroll to keep selected item visible
  useLayoutEffect(() => {
    if (!scrollRef.current || itemPositions.length === 0) return
    const current = itemPositions[stableIndex]
    if (!current) return

    const box = scrollRef.current
    const actualHeight = box.scrollHeight ?? 0
    const calculatedHeight = itemPositions[itemPositions.length - 1]?.end ?? 1

    // Scale calculated position by actual/calculated ratio
    const scale = actualHeight / calculatedHeight
    const scaledStart = current.start * scale

    // Show 1 item above if possible
    const prev = stableIndex > 0 ? itemPositions[stableIndex - 1] : null
    const margin = prev ? (current.start - prev.start) * scale : 0

    box.scrollTo({ x: 0, y: Math.max(0, scaledStart - margin) })
  }, [stableIndex, itemPositions])

  if (items.length === 0) {
    return (
      <box
        style={{
          flexGrow: 1,
          width: "100%",
          padding: 1,
          paddingLeft: 2,
          backgroundColor: theme.backgroundPanel,
          justifyContent: "center",
          alignItems: "center"
        }}
      >
        <text fg={theme.textMuted}>No items to display</text>
      </box>
    )
  }

  if (view === "settings") {
    return <SettingsTable items={items} selectedIndex={stableIndex} />
  }

  if (view === "notifications") {
    return <NotificationsTable items={items} selectedIndex={stableIndex} />
  }

  return (
    <box style={{ flexGrow: 1, width: "100%", paddingLeft: 1 }}>
      <scrollbox
        ref={scrollRef}
        style={{
          flexGrow: 1,
          width: "100%",
          backgroundColor: theme.backgroundPanel
        }}
      >
        <box style={{ flexDirection: "column", width: "100%" }}>
          {items.map((item, i) => (
            <ListItemRow key={i} item={item} selected={i === stableIndex} isFirst={i === 0} />
          ))}
        </box>
      </scrollbox>
      {currentGroupHeader && (
        <box style={{ position: "absolute", top: 0, width: "100%" }}>
          <ListItemRow item={currentGroupHeader} selected={items[stableIndex] === currentGroupHeader} isFirst={true} />
        </box>
      )}
    </box>
  )
}
