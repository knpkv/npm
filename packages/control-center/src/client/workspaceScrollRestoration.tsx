import { type ReactElement, useEffect } from "react"
import { type Location, ScrollRestoration, useLocation } from "react-router"

const MAXIMUM_SAVED_WORKSPACE_SCROLL_POSITIONS = 32
const MAXIMUM_DEFERRED_RESTORATION_FRAMES = 300
const savedWorkspaceScrollPositions = new Map<string, number>()

/**
 * Reuse scroll positions for the same exact workspace view even when an
 * application Back link creates a new history entry.
 */
export const workspaceScrollRestorationKey = ({
  hash,
  pathname,
  search
}: Pick<Location, "hash" | "pathname" | "search">): string => `${pathname}${search}${hash}`

/** Remember the current viewport before opening a canonical entity route. */
export const rememberWorkspaceScrollPosition = (location: Pick<Location, "hash" | "pathname" | "search">): void => {
  const key = workspaceScrollRestorationKey(location)
  savedWorkspaceScrollPositions.delete(key)
  savedWorkspaceScrollPositions.set(key, window.scrollY)
  if (savedWorkspaceScrollPositions.size <= MAXIMUM_SAVED_WORKSPACE_SCROLL_POSITIONS) return
  for (const oldestKey of savedWorkspaceScrollPositions.keys()) {
    savedWorkspaceScrollPositions.delete(oldestKey)
    break
  }
}

/**
 * Restore ordinary history positions through React Router and retry entity
 * round-trip restoration until lazy workspace content can hold the viewport.
 */
export const WorkspaceScrollRestoration = (): ReactElement => {
  const location = useLocation()
  const key = workspaceScrollRestorationKey(location)

  useEffect(() => {
    const target = savedWorkspaceScrollPositions.get(key)
    if (target === undefined || target === 0) return
    savedWorkspaceScrollPositions.delete(key)
    let frame = 0
    let requestId = 0
    const restore = (): void => {
      window.scrollTo(0, target)
      frame += 1
      if (Math.abs(window.scrollY - target) <= 2 || frame >= MAXIMUM_DEFERRED_RESTORATION_FRAMES) return
      requestId = window.requestAnimationFrame(restore)
    }
    requestId = window.requestAnimationFrame(restore)
    return () => window.cancelAnimationFrame(requestId)
  }, [key])

  return <ScrollRestoration getKey={workspaceScrollRestorationKey} storageKey="control-center-scroll-positions" />
}
