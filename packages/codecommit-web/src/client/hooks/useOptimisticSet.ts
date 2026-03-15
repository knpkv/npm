/**
 * Tracks optimistic add/remove operations on a set of items.
 *
 * Shows pending items with a loading state until the server-side data
 * (represented by a stable key) actually changes. Clears pending state
 * only when the real data confirms the change.
 *
 * **Mental model**
 *
 * - `items`: current server-confirmed set
 * - `pendingAdd` / `pendingRemove`: optimistic predictions shown with spinners
 * - `stableKey`: derived from server items — pending clears when key changes
 * - Auto-refreshes when permission prompt clears (gate approved → API in flight)
 *
 * **Common tasks**
 *
 * - Add item: {@link add} — sets pendingAdd, calls onChange
 * - Remove item: {@link remove} — sets pendingRemove, calls onChange
 * - Check pending: `pendingAdd === name` or `pendingRemove === name`
 *
 * @module
 */
import { useEffect, useRef, useState } from "react"

interface UseOptimisticSetOptions {
  /** Current server-confirmed items */
  readonly items: ReadonlyArray<string>
  /** Stable key derived from server data — pending clears when this changes */
  readonly stableKey: string
  /** Whether a permission prompt is currently showing */
  readonly permissionPrompt: boolean
  /** Called after permission prompt clears */
  readonly onRefresh: () => void
}

interface UseOptimisticSetResult {
  readonly pendingAdd: string | null
  readonly pendingRemove: string | null
  readonly add: (name: string) => void
  readonly remove: (name: string) => void
}

export function useOptimisticSet({
  items: _items,
  onRefresh,
  permissionPrompt,
  stableKey
}: UseOptimisticSetOptions): UseOptimisticSetResult {
  const [pendingAdd, setPendingAdd] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)
  const hadPromptRef = useRef(false)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-refresh when permission prompt clears (prompt mode)
  useEffect(() => {
    if (permissionPrompt) {
      hadPromptRef.current = true
    } else if (hadPromptRef.current) {
      hadPromptRef.current = false
      onRefresh()
    }
  }, [permissionPrompt, onRefresh])

  // Auto-refresh fallback: when pending and no prompt appeared (always-allow mode),
  // poll with increasing delay until server data changes. Absolute 30s timeout.
  useEffect(() => {
    if ((pendingAdd || pendingRemove) && !permissionPrompt) {
      let delay = 500
      const startTime = Date.now()
      const poll = () => {
        if (Date.now() - startTime > 30_000) {
          setPendingAdd(null)
          setPendingRemove(null)
          return
        }
        onRefresh()
        delay = Math.min(delay * 1.5, 3000)
        refreshTimerRef.current = setTimeout(poll, delay)
      }
      refreshTimerRef.current = setTimeout(poll, delay)
      return () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      }
    }
  }, [pendingAdd, pendingRemove, permissionPrompt, onRefresh])

  // Clear pending state when server data changes
  useEffect(() => {
    setPendingAdd(null)
    setPendingRemove(null)
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
  }, [stableKey])

  return {
    pendingAdd,
    pendingRemove,
    add: (name: string) => setPendingAdd(name),
    remove: (name: string) => setPendingRemove(name)
  }
}
