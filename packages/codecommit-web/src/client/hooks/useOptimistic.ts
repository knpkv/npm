import { useCallback, useRef, useState } from "react"

/**
 * Optimistic local override that auto-resets when the server value changes.
 * No useEffect — uses ref comparison during render to detect server changes.
 *
 * @param serverValue - The authoritative value from the server
 * @returns [resolvedValue, setOptimistic] — resolved value prefers optimistic, setter to apply override
 */
export function useOptimistic<T>(serverValue: T): readonly [T, (value: T | null) => void] {
  const [optimistic, setOptimistic] = useState<T | null>(null)
  const prevServerRef = useRef(serverValue)

  // Reset optimistic override when server value changes (no useEffect needed)
  if (prevServerRef.current !== serverValue) {
    prevServerRef.current = serverValue
    if (optimistic !== null) {
      setOptimistic(null)
    }
  }

  return [optimistic ?? serverValue, setOptimistic] as const
}

/**
 * Optimistic Set — accumulates IDs locally, auto-clears when server key changes.
 * Useful for bulk "mark as read" where individual items are optimistically updated.
 *
 * @param serverKey - A value that changes when server data refreshes (e.g., first item ID)
 * @returns [optimisticIds, addId, addAll] — the set + mutators
 */
export function useOptimisticSet<T>(serverKey: unknown): readonly [
  ReadonlySet<T>,
  (id: T) => void,
  (ids: Iterable<T>) => void,
  (id: T) => void
] {
  const [ids, setIds] = useState<ReadonlySet<T>>(new Set())
  const prevKeyRef = useRef(serverKey)

  if (prevKeyRef.current !== serverKey) {
    prevKeyRef.current = serverKey
    if (ids.size > 0) {
      setIds(new Set())
    }
  }

  const addOne = useCallback((id: T) => {
    setIds((prev) => new Set(prev).add(id))
  }, [])

  const addAll = useCallback((items: Iterable<T>) => {
    setIds(new Set(items))
  }, [])

  const removeOne = useCallback((id: T) => {
    setIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  return [ids, addOne, addAll, removeOne] as const
}
