import { useAtom, useAtomValue } from "@effect-atom/atom-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { NotificationItem } from "../atoms/app.js"
import { appStateAtom, loadMoreNotificationsAtom } from "../atoms/app.js"

interface Page {
  readonly items: ReadonlyArray<NotificationItem>
  readonly nextCursor?: number
}

export interface NotificationFilters {
  readonly filter?: "system" | "prs" | undefined
  readonly unreadOnly?: boolean | undefined
}

export function useInfiniteNotifications(filters: NotificationFilters = {}) {
  const { filter, unreadOnly } = filters
  const useRest = filter !== undefined || unreadOnly === true

  const state = useAtomValue(appStateAtom)
  const sseFirstPage = state.notifications

  const [extraPages, setExtraPages] = useState<ReadonlyArray<Page>>([])
  const [restFirstPage, setRestFirstPage] = useState<Page | null>(null)
  const [loadMoreResult, loadMore] = useAtom(loadMoreNotificationsAtom, { mode: "promise" })

  // Reset when filters change
  const prevKeyRef = useRef(`${filter}:${unreadOnly}`)
  const key = `${filter}:${unreadOnly}`
  if (prevKeyRef.current !== key) {
    prevKeyRef.current = key
    setExtraPages([])
    setRestFirstPage(null)
  }

  // Reset extra pages when SSE first page changes (SSE mode only)
  const firstItemId = sseFirstPage?.items[0]?.id
  const prevFirstItemIdRef = useRef(firstItemId)
  if (!useRest && prevFirstItemIdRef.current !== firstItemId) {
    prevFirstItemIdRef.current = firstItemId
    if (extraPages.length > 0) setExtraPages([])
  }

  // Build URL params for REST calls
  const restParams = useMemo(() => ({
    limit: 20,
    ...(filter ? { filter } : {}),
    ...(unreadOnly ? { unreadOnly: 1 } : {})
  }), [filter, unreadOnly])

  // Fetch first page via REST when filters are active
  useEffect(() => {
    if (!useRest) return
    let cancelled = false
    loadMore({ urlParams: restParams }).then((result) => {
      if (cancelled) return
      setRestFirstPage({
        items: result.items,
        ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {})
      })
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [useRest, restParams, loadMore])

  const firstPage = useRest ? restFirstPage : sseFirstPage

  const lastCursor = extraPages.length > 0
    ? extraPages[extraPages.length - 1]!.nextCursor
    : firstPage?.nextCursor

  const hasMore = lastCursor !== undefined
  const isLoading = loadMoreResult.waiting

  const fetchMore = useCallback(async () => {
    if (!hasMore || isLoading || lastCursor === undefined) return
    try {
      const result = await loadMore({
        urlParams: { ...restParams, cursor: lastCursor }
      })
      const page: Page = {
        items: result.items,
        ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {})
      }
      setExtraPages((prev) => [...prev, page])
    } catch {
      // request failed — keep current state
    }
  }, [hasMore, isLoading, lastCursor, loadMore, restParams])

  const items = useMemo(() => {
    const base = firstPage?.items ?? []
    if (extraPages.length === 0) return base
    return [...base, ...extraPages.flatMap((p) => p.items)]
  }, [firstPage?.items, extraPages])

  return { items, hasMore, isLoading, loadMore: fetchMore } as const
}
