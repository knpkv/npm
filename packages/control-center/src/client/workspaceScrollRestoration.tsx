import { type ReactElement, useEffect } from "react"
import { type Location, ScrollRestoration, useLocation } from "react-router"

const MAXIMUM_DEFERRED_RESTORATION_FRAMES = 300
export const RELEASE_PREVIEW_SCROLL_SELECTOR = "[data-rly-release-preview-scroll]"
export const SCROLL_POSITION_TOLERANCE = 2

export type SavedWorkspaceScrollPosition = readonly [
  top: number,
  preview: boolean,
  entityPaths: ReadonlyArray<string>,
  active: boolean
]

export const savedWorkspaceScrollPositions = new Map<string, SavedWorkspaceScrollPosition>()

/**
 * Reuse scroll positions for the same exact workspace view even when an
 * application Back link creates a new history entry.
 */
export const workspaceScrollRestorationKey = ({
  hash,
  pathname,
  search
}: Pick<Location, "hash" | "pathname" | "search">): string => `${pathname}${search}${hash}`

/**
 * Retry entity round-trip restoration until lazy workspace content can hold
 * the viewport.
 */
export const DeferredWorkspaceScrollRestoration = (): null => {
  const location = useLocation()
  const key = workspaceScrollRestorationKey(location)

  useEffect(() => {
    for (const [originKey, saved] of savedWorkspaceScrollPositions) {
      if (originKey === key) continue
      if (saved[2].includes(location.pathname)) {
        if (!saved[3]) savedWorkspaceScrollPositions.set(originKey, [saved[0], saved[1], saved[2], true])
        continue
      }
      savedWorkspaceScrollPositions.delete(originKey)
    }
    const target = savedWorkspaceScrollPositions.get(key)
    if (target === undefined || !target[3]) return
    const targetTop = target[0]
    const targetPreview = target[1]
    let frame = 0
    let requestId = 0
    let lastAppliedTarget = -1
    const consumeTarget = (): void => {
      if (savedWorkspaceScrollPositions.get(key) === target) savedWorkspaceScrollPositions.delete(key)
    }
    const restore = (): void => {
      frame += 1
      const previewScroller = targetPreview
        ? document.querySelector<HTMLElement>(RELEASE_PREVIEW_SCROLL_SELECTOR)
        : null
      if (targetPreview && previewScroller === null) {
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
      const reachableTarget = Math.min(targetTop, maximumScrollPosition)
      if (reachableTarget > lastAppliedTarget + SCROLL_POSITION_TOLERANCE) {
        if (previewScroller === null) {
          window.scrollTo(0, reachableTarget)
        } else {
          previewScroller.scrollTop = reachableTarget
        }
        lastAppliedTarget = reachableTarget
      }
      const restoredPosition = previewScroller === null ? window.scrollY : previewScroller.scrollTop
      if (Math.abs(restoredPosition - targetTop) <= SCROLL_POSITION_TOLERANCE) {
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
