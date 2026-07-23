import { type ReactElement, useEffect } from "react"
import { type Location, ScrollRestoration, useLocation } from "react-router"

const MAXIMUM_SAVED_WORKSPACE_SCROLL_POSITIONS = 32
const MAXIMUM_DEFERRED_RESTORATION_FRAMES = 300
const RELEASE_PREVIEW_SCROLL_SELECTOR = "[data-rly-release-preview-scroll]"
const SCROLL_POSITION_TOLERANCE = 2

interface SavedWorkspaceScrollPosition {
  readonly preview: boolean
  readonly top: number
}

const savedWorkspaceScrollPositions = new Map<string, SavedWorkspaceScrollPosition>()

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
  const previewScroller = document.querySelector<HTMLElement>(RELEASE_PREVIEW_SCROLL_SELECTOR)
  const savedPosition: SavedWorkspaceScrollPosition = {
    preview: previewScroller !== null,
    top: previewScroller?.scrollTop ?? window.scrollY
  }
  if (savedPosition.top <= SCROLL_POSITION_TOLERANCE) return
  savedWorkspaceScrollPositions.set(key, savedPosition)
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
    if (target === undefined) return
    let frame = 0
    let requestId = 0
    let lastAppliedTarget = -1
    const consumeTarget = (): void => {
      if (savedWorkspaceScrollPositions.get(key) === target) savedWorkspaceScrollPositions.delete(key)
    }
    const restore = (): void => {
      frame += 1
      const previewScroller = target.preview
        ? document.querySelector<HTMLElement>(RELEASE_PREVIEW_SCROLL_SELECTOR)
        : null
      if (target.preview && previewScroller === null) {
        if (frame >= MAXIMUM_DEFERRED_RESTORATION_FRAMES) {
          consumeTarget()
          return
        }
        requestId = window.requestAnimationFrame(restore)
        return
      }
      const currentPosition = previewScroller === null ? window.scrollY : previewScroller.scrollTop
      if (lastAppliedTarget >= 0 && Math.abs(currentPosition - lastAppliedTarget) > SCROLL_POSITION_TOLERANCE) {
        consumeTarget()
        return
      }
      const maximumScrollPosition =
        previewScroller === null
          ? Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
          : Math.max(0, previewScroller.scrollHeight - previewScroller.clientHeight)
      const reachableTarget = Math.min(target.top, maximumScrollPosition)
      if (reachableTarget > lastAppliedTarget + SCROLL_POSITION_TOLERANCE) {
        if (previewScroller === null) {
          window.scrollTo(0, reachableTarget)
        } else {
          previewScroller.scrollTop = reachableTarget
        }
        lastAppliedTarget = reachableTarget
      }
      const restoredPosition = previewScroller === null ? window.scrollY : previewScroller.scrollTop
      if (Math.abs(restoredPosition - target.top) <= SCROLL_POSITION_TOLERANCE) {
        consumeTarget()
        return
      }
      if (frame >= MAXIMUM_DEFERRED_RESTORATION_FRAMES) {
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
    <ScrollRestoration storageKey="control-center-scroll-positions" />
  </>
)
