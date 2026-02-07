import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import type { Domain } from "@knpkv/codecommit-core"
import { type ScrollBoxRenderable } from "@opentui/core"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
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
import { type ListItem, type TuiView, buildListItems } from "../ListBuilder.js"
import { ListItemRow } from "./ListItemRow.js"
import { applySettingsFilter, computeItemPositions, findGroupHeader, findStableIndex } from "./mainlist-utils.js"
import { NotificationsTable } from "./NotificationsTable.js"
import { SettingsTable } from "./SettingsTable.js"

// ── Hooks ───────────────────────────────────────────────────────────

const defaultState: AppState = { status: "loading", pullRequests: [], accounts: [] }

/** Caches last successful AppState to avoid flash during reloads */
const useCachedAppState = (result: Result.Result<AppState>) => {
  const [cached, setCached] = useState<AppState>(defaultState)
  useEffect(() => {
    if (Result.isSuccess(result)) setCached(result.value)
  }, [result])
  return Result.isSuccess(result) ? result.value : cached
}

/** Builds filtered list items from app state + view + filters */
const useFilteredItems = (state: AppState, view: TuiView): ReadonlyArray<ListItem> => {
  const filterText = useAtomValue(filterTextAtom)
  const quickFilterType = useAtomValue(quickFilterTypeAtom)
  const quickFilterValues = useAtomValue(quickFilterValuesAtom)
  const currentUser = useAtomValue(currentUserAtom)
  const settingsFilter = useAtomValue(settingsFilterAtom)
  const notificationsResult = useAtomValue(notificationsAtom)
  const notifications = Result.getOrElse(notificationsResult, () => ({ items: [] }))

  const quickFilter = useMemo(
    () => ({ type: quickFilterType, value: quickFilterValues[quickFilterType], currentUser }),
    [quickFilterType, quickFilterValues, currentUser]
  )

  const rawItems = useMemo(
    () => buildListItems(state, view, filterText, notifications.items, quickFilter),
    [state, view, filterText, notifications.items, quickFilter]
  )

  return useMemo(
    () => (view === "settings" ? applySettingsFilter(rawItems, settingsFilter) : rawItems),
    [rawItems, view, settingsFilter]
  )
}

/** Resolves a stable selected index that survives list refreshes */
const useStableIndex = (items: ReadonlyArray<ListItem>, view: string): number => {
  const selectedIndex = useAtomValue(selectedIndexAtom)
  const selectedPrId = useAtomValue(selectedPrIdAtom)
  return useMemo(
    () => findStableIndex(items, view, selectedPrId, selectedIndex),
    [items, selectedPrId, selectedIndex, view]
  )
}

/** Syncs currentPR atom and selectedPrId when selection changes */
const useSyncCurrentPR = (items: ReadonlyArray<ListItem>, stableIndex: number, view: string) => {
  const setCurrentPR = useAtomSet(currentPRAtom)
  const selectedPrId = useAtomValue(selectedPrIdAtom)
  const setSelectedPrId = useAtomSet(selectedPrIdAtom)

  const currentPR = useMemo(() => {
    const item = items[stableIndex]
    return item?.type === "pr" ? item.pr : null
  }, [items, stableIndex])

  useEffect(() => {
    if (view === "details") return
    setCurrentPR(currentPR)
    if (currentPR && currentPR.id !== selectedPrId) setSelectedPrId(currentPR.id)
  }, [currentPR, setCurrentPR, setSelectedPrId, selectedPrId, view])
}

/** Scrolls to keep the selected item visible in the scrollbox */
const useScrollToSelected = (
  scrollRef: React.RefObject<ScrollBoxRenderable | null>,
  items: ReadonlyArray<ListItem>,
  stableIndex: number
) => {
  const positions = useMemo(() => computeItemPositions(items), [items])

  useLayoutEffect(() => {
    if (!scrollRef.current || positions.length === 0) return
    const pos = positions[stableIndex]
    if (!pos) return

    const box = scrollRef.current
    const scale = (box.scrollHeight ?? 0) / (positions[positions.length - 1]?.end ?? 1)
    const scaledStart = pos.start * scale
    const prev = stableIndex > 0 ? positions[stableIndex - 1] : null
    const margin = prev ? (pos.start - prev.start) * scale : 0

    box.scrollTo({ x: 0, y: Math.max(0, scaledStart - margin) })
  }, [stableIndex, positions])
}

// ── Component ───────────────────────────────────────────────────────

interface MainListProps {
  readonly onSelectPR?: (pr: Domain.PullRequest) => void
}

/**
 * Main list component showing PRs, settings, or errors based on view
 * @category components
 */
export function MainList({ onSelectPR }: MainListProps) {
  const { theme } = useTheme()
  const scrollRef = useRef<ScrollBoxRenderable>(null)

  const result = useAtomValue(appStateAtom)
  const view = useAtomValue(viewAtom)
  const setView = useAtomSet(viewAtom)
  const toggleAccount = useAtomSet(toggleAccountAtom)

  const state = useCachedAppState(result)
  const items = useFilteredItems(state, view)
  const stableIndex = useStableIndex(items, view)
  const currentGroupHeader = useMemo(() => findGroupHeader(items, stableIndex), [items, stableIndex])

  useSyncCurrentPR(items, stableIndex, view)
  useScrollToSelected(scrollRef, items, stableIndex)

  useListNavigation(
    items,
    () => {
      const item = items[stableIndex]
      if (item?.type === "pr" && onSelectPR) onSelectPR(item.pr)
      else if (item?.type === "account") setView("prs")
    },
    () => {
      const item = items[stableIndex]
      if (item?.type === "account") toggleAccount(item.account.profile)
    }
  )

  // ── Render ──────────────────────────────────────────────────────

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

  if (view === "settings") return <SettingsTable items={items} selectedIndex={stableIndex} />
  if (view === "notifications") return <NotificationsTable items={items} selectedIndex={stableIndex} />

  return (
    <box style={{ flexGrow: 1, width: "100%", paddingLeft: 1 }}>
      <scrollbox ref={scrollRef} style={{ flexGrow: 1, width: "100%", backgroundColor: theme.backgroundPanel }}>
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
