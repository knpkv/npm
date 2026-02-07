/**
 * Pure helpers for MainList layout, filtering, and scroll position.
 *
 * Separated from MainList.tsx to avoid transitive React/OpenTUI deps in tests.
 *
 * @internal
 */
import type { ListItem } from "../ListBuilder.js"

export interface ParsedSettingsFilter {
  readonly status: "all" | "on" | "off"
  readonly name: string
}

export const parseSettingsFilter = (raw: string): ParsedSettingsFilter => {
  const lower = raw.toLowerCase()
  if (lower.startsWith("on:")) return { status: "on", name: lower.slice(3) }
  if (lower.startsWith("off:")) return { status: "off", name: lower.slice(4) }
  return { status: "all", name: lower }
}

export const applySettingsFilter = (items: ReadonlyArray<ListItem>, filter: string): ReadonlyArray<ListItem> => {
  if (!filter) return items
  const { name, status } = parseSettingsFilter(filter)
  return items.filter((item) => {
    if (item.type !== "account") return false
    if (status === "on" && !item.account.enabled) return false
    if (status === "off" && item.account.enabled) return false
    if (name && !item.account.profile.toLowerCase().includes(name)) return false
    return true
  })
}

export const findStableIndex = (
  items: ReadonlyArray<ListItem>,
  view: string,
  selectedPrId: string | null,
  selectedIndex: number
): number => {
  if ((view === "prs" || view === "details") && selectedPrId) {
    const idx = items.findIndex((item) => item.type === "pr" && item.pr.id === selectedPrId)
    if (idx !== -1) return idx
  }
  if (selectedIndex >= items.length) return Math.max(0, items.length - 1)
  if (selectedIndex < 0) return 0
  return selectedIndex
}

export const findGroupHeader = (items: ReadonlyArray<ListItem>, index: number): ListItem | null => {
  if (items.length === 0) return null
  const clamped = Math.min(index, items.length - 1)
  if (clamped < 0) return null
  for (let i = clamped; i >= 0; i--) {
    const item = items[i]
    if (item && item.type === "header") return item
  }
  return null
}

export interface ItemPosition {
  readonly start: number
  readonly end: number
}

export const computeItemPositions = (items: ReadonlyArray<ListItem>): ReadonlyArray<ItemPosition> => {
  const positions: Array<ItemPosition> = []
  let y = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    const start = y
    let height = 2
    if (item.type === "header") {
      height = i === 0 ? 2 : 3
    } else if (item.type === "pr") {
      const descLines = item.pr.description ? Math.min(item.pr.description.split("\n").length, 5) : 0
      height = 1 + 1 + descLines + 1 + 1
    }
    y += height
    positions.push({ start, end: y })
  }
  return positions
}
