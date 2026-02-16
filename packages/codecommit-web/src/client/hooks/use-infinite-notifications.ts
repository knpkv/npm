import { useAtom, useAtomValue } from "@effect-atom/atom-react"
import { useCallback, useMemo, useRef, useState } from "react"
import type { NotificationItem } from "../atoms/app.js"
import { appStateAtom, loadMoreNotificationsAtom } from "../atoms/app.js"

interface Page {
  readonly items: ReadonlyArray<NotificationItem>
  readonly nextCursor?: number
}

export function useInfiniteNotifications() {
  const state = useAtomValue(appStateAtom)
  const firstPage = state.notifications

  const [extraPages, setExtraPages] = useState<ReadonlyArray<Page>>([])
  const [loadMoreResult, loadMore] = useAtom(loadMoreNotificationsAtom, { mode: "promise" })

  // Reset extra pages when SSE first page changes — ref comparison in render, no useEffect
  const firstItemId = firstPage?.items[0]?.id
  const prevFirstItemIdRef = useRef(firstItemId)
  if (prevFirstItemIdRef.current !== firstItemId) {
    prevFirstItemIdRef.current = firstItemId
    if (extraPages.length > 0) {
      setExtraPages([])
    }
  }

  const lastCursor = extraPages.length > 0
    ? extraPages[extraPages.length - 1]!.nextCursor
    : firstPage?.nextCursor

  const hasMore = lastCursor !== undefined
  const isLoading = loadMoreResult.waiting

  const fetchMore = useCallback(async () => {
    if (!hasMore || isLoading || lastCursor === undefined) return
    try {
      const result = await loadMore({ urlParams: { limit: 20, cursor: lastCursor } })
      const page: Page = {
        items: result.items,
        ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {})
      }
      setExtraPages((prev) => [...prev, page])
    } catch {
      // request failed — keep current state
    }
  }, [hasMore, isLoading, lastCursor, loadMore])

  const items = useMemo(() => {
    const base = firstPage?.items ?? []
    if (extraPages.length === 0) return base
    return [...base, ...extraPages.flatMap((p) => p.items)]
  }, [firstPage?.items, extraPages])

  return { items, hasMore, isLoading, loadMore: fetchMore } as const
}
