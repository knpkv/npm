import type { Location } from "react-router"

import {
  RELEASE_PREVIEW_SCROLL_SELECTOR,
  type SavedWorkspaceScrollPosition,
  savedWorkspaceScrollPositions,
  SCROLL_POSITION_TOLERANCE,
  workspaceScrollRestorationKey
} from "./workspaceScrollRestoration.js"

const MAXIMUM_SAVED_WORKSPACE_SCROLL_POSITIONS = 32

interface WorkspaceNavigationClick {
  readonly altKey: boolean
  readonly button: number
  readonly ctrlKey: boolean
  readonly defaultPrevented: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}

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
export const rememberWorkspaceScrollPosition = (
  location: Pick<Location, "hash" | "pathname" | "search">,
  entityPath: string
): void => {
  const key = workspaceScrollRestorationKey(location)
  savedWorkspaceScrollPositions.delete(key)
  const previewScroller = document.querySelector<HTMLElement>(RELEASE_PREVIEW_SCROLL_SELECTOR)
  const savedPosition = [
    previewScroller?.scrollTop ?? window.scrollY,
    previewScroller !== null,
    entityPath,
    false
  ] satisfies SavedWorkspaceScrollPosition
  if (savedPosition[0] <= SCROLL_POSITION_TOLERANCE) return
  for (const [originKey, saved] of savedWorkspaceScrollPositions) {
    if (saved[3] && saved[2] === location.pathname) {
      savedWorkspaceScrollPositions.set(originKey, [saved[0], saved[1], entityPath, true])
    }
  }
  savedWorkspaceScrollPositions.set(key, savedPosition)
  if (savedWorkspaceScrollPositions.size <= MAXIMUM_SAVED_WORKSPACE_SCROLL_POSITIONS) return
  for (const oldestKey of savedWorkspaceScrollPositions.keys()) {
    savedWorkspaceScrollPositions.delete(oldestKey)
    break
  }
}
