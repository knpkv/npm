import { type ReactElement, useEffect } from "react"
import { type Location, ScrollRestoration, useLocation } from "react-router"

const MAXIMUM_SAVED_WORKSPACE_SCROLL_POSITIONS = 32
const MAXIMUM_DEFERRED_RESTORATION_FRAMES = 300
const MAXIMUM_STABLE_SCROLL_HEIGHT_FRAMES = 12
const SCROLL_POSITION_TOLERANCE = 2
const savedWorkspaceScrollPositions = new Map<string, number>()

interface WorkspaceNavigationClick {
  readonly altKey: boolean
  readonly button: number
  readonly ctrlKey: boolean
  readonly defaultPrevented: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}

/**
 * Reuse scroll positions for the same exact workspace view even when an
 * application Back link creates a new history entry.
 */
export const workspaceScrollRestorationKey = ({
  hash,
  pathname,
  search
}: Pick<Location, "hash" | "pathname" | "search">): string => `${pathname}${search}${hash}`

/** Match the same primary, unmodified, same-tab click contract as React Router. */
export const shouldRememberWorkspaceScrollPosition = (event: WorkspaceNavigationClick, linkTarget: string): boolean =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  (linkTarget === "" || linkTarget === "_self")

/** Remember the current viewport before opening a canonical entity route. */
export const rememberWorkspaceScrollPosition = (location: Pick<Location, "hash" | "pathname" | "search">): void => {
  const key = workspaceScrollRestorationKey(location)
  savedWorkspaceScrollPositions.delete(key)
  if (window.scrollY <= SCROLL_POSITION_TOLERANCE) return
  savedWorkspaceScrollPositions.set(key, window.scrollY)
  if (savedWorkspaceScrollPositions.size <= MAXIMUM_SAVED_WORKSPACE_SCROLL_POSITIONS) return
  for (const oldestKey of savedWorkspaceScrollPositions.keys()) {
    savedWorkspaceScrollPositions.delete(oldestKey)
    break
  }
}

/**
 * Retry entity round-trip restoration until lazy workspace content can hold
 * the viewport.
 */
export const DeferredWorkspaceScrollRestoration = (): null => {
  const location = useLocation()
  const key = workspaceScrollRestorationKey(location)

  useEffect(() => {
    const target = savedWorkspaceScrollPositions.get(key)
    if (target === undefined || target === 0) return
    let frame = 0
    let requestId = 0
    let previousMaximumScrollY = -1
    let stableScrollHeightFrames = 0
    let lastAppliedTarget = -1
    const consumeTarget = (): void => {
      if (savedWorkspaceScrollPositions.get(key) === target) savedWorkspaceScrollPositions.delete(key)
    }
    const restore = (): void => {
      frame += 1
      const maximumScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      const reachableTarget = Math.min(target, maximumScrollY)
      if (reachableTarget > lastAppliedTarget + SCROLL_POSITION_TOLERANCE) {
        window.scrollTo(0, reachableTarget)
        lastAppliedTarget = reachableTarget
      }
      if (Math.abs(window.scrollY - target) <= SCROLL_POSITION_TOLERANCE) {
        consumeTarget()
        return
      }
      if (maximumScrollY <= previousMaximumScrollY + SCROLL_POSITION_TOLERANCE) {
        stableScrollHeightFrames += 1
      } else {
        stableScrollHeightFrames = 0
      }
      previousMaximumScrollY = maximumScrollY
      if (
        stableScrollHeightFrames >= MAXIMUM_STABLE_SCROLL_HEIGHT_FRAMES ||
        frame >= MAXIMUM_DEFERRED_RESTORATION_FRAMES
      ) {
        consumeTarget()
        return
      }
      requestId = window.requestAnimationFrame(restore)
    }
    requestId = window.requestAnimationFrame(restore)
    return () => window.cancelAnimationFrame(requestId)
  }, [key])

  return null
}

/** Restore ordinary history positions and canonical-entity round trips. */
export const WorkspaceScrollRestoration = (): ReactElement => (
  <>
    <DeferredWorkspaceScrollRestoration />
    <ScrollRestoration getKey={workspaceScrollRestorationKey} storageKey="control-center-scroll-positions" />
  </>
)
