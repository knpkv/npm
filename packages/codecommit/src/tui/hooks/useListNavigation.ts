import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import type { KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useEffect } from "react"
import { selectedIndexAtom, selectedPrIdAtom, viewAtom } from "../atoms/ui.js"
import { useDialog } from "../context/dialog.js"
import type { ListItem } from "@knpkv/codecommit-core/ListBuilder"

function isSelectable(item: ListItem | undefined): boolean {
  if (!item) return false
  return item.type === "pr" || item.type === "account" || item.type === "notification"
}

export function useListNavigation(items: ReadonlyArray<ListItem>, onSelect: () => void, onToggle?: () => void) {
  const selectedIndex = useAtomValue(selectedIndexAtom)
  const setSelectedIndex = useAtomSet(selectedIndexAtom)
  const setSelectedPrId = useAtomSet(selectedPrIdAtom)
  const view = useAtomValue(viewAtom)
  const dialog = useDialog()

  // Helper to update both index and PR ID atomically
  const navigate = (newIndex: number) => {
    setSelectedIndex(newIndex)
    const item = items[newIndex]
    if (item?.type === "pr") {
      setSelectedPrId(item.pr.id)
    }
  }

  // Sync selected index when items change or become unselectable
  useEffect(() => {
    if (items.length === 0) return

    let index = selectedIndex
    if (index >= items.length) index = items.length - 1
    if (index < 0) index = 0

    // If current item is not selectable, find nearest
    if (items[index] && !isSelectable(items[index])) {
      // Search down
      let found = -1
      for (let i = index; i < items.length; i++) {
        if (items[i] && isSelectable(items[i])) {
          found = i
          break
        }
      }
      // Search up if not found down
      if (found === -1) {
        for (let i = index; i >= 0; i--) {
          if (items[i] && isSelectable(items[i])) {
            found = i
            break
          }
        }
      }
      if (found !== -1) index = found
    }

    if (index !== selectedIndex) {
      setSelectedIndex(index)
    }
  }, [items, selectedIndex, setSelectedIndex])

  useKeyboard((key: KeyEvent) => {
    if (dialog.current) return
    if (view === "details") return

    if (key.name === "down") {
      let next = selectedIndex + 1
      while (next < items.length && (!items[next] || !isSelectable(items[next]))) {
        next++
      }
      if (next < items.length) navigate(next)
    } else if (key.name === "up") {
      let prev = selectedIndex - 1
      while (prev >= 0 && (!items[prev] || !isSelectable(items[prev]))) {
        prev--
      }
      if (prev >= 0) navigate(prev)
    } else if (key.name === "pageup") {
      let prev = Math.max(selectedIndex - 10, 0)
      while (prev > 0 && (!items[prev] || !isSelectable(items[prev]))) prev--
      if (prev >= 0 && items[prev] && isSelectable(items[prev])) navigate(prev)
    } else if (key.name === "pagedown") {
      let next = Math.min(selectedIndex + 10, items.length - 1)
      while (next < items.length && (!items[next] || !isSelectable(items[next]))) next++
      if (next >= items.length) {
        next = items.length - 1
        while (next > selectedIndex && (!items[next] || !isSelectable(items[next]))) next--
      }
      if (next >= 0 && items[next] && isSelectable(items[next])) navigate(next)
    } else if (key.name === "home") {
      let next = 0
      while (next < items.length && (!items[next] || !isSelectable(items[next]))) next++
      if (next < items.length) navigate(next)
    } else if (key.name === "end") {
      let prev = items.length - 1
      while (prev >= 0 && (!items[prev] || !isSelectable(items[prev]))) prev--
      if (prev >= 0) navigate(prev)
    } else if (key.name === "return") {
      onSelect()
    } else if (key.name === "space") {
      if (onToggle) onToggle()
    }
  })
}
