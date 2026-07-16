import { useSyncExternalStore } from "react"

const COMPACT_RELEASE_PREVIEW_QUERY = "(max-width: 40rem)"
const REDUCED_RELEASE_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

const mediaQuery = (query: string): MediaQueryList | null =>
  typeof window === "undefined" ? null : window.matchMedia(query)

const subscribe = (onChange: () => void): () => void => {
  const query = mediaQuery(COMPACT_RELEASE_PREVIEW_QUERY)
  if (query === null) return () => undefined
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

const snapshot = (): boolean => mediaQuery(COMPACT_RELEASE_PREVIEW_QUERY)?.matches ?? false

const subscribeToReducedMotion = (onChange: () => void): () => void => {
  const query = mediaQuery(REDUCED_RELEASE_MOTION_QUERY)
  if (query === null) return () => undefined
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

const reducedMotionSnapshot = (): boolean => mediaQuery(REDUCED_RELEASE_MOTION_QUERY)?.matches ?? false

/** Select the full-screen compact release sheet at the same breakpoint as rly release rows. */
export const useCompactReleasePreview = (): boolean => useSyncExternalStore(subscribe, snapshot, () => false)

/** Disable the sole orchestrated release transition when the user requests reduced motion. */
export const usePrefersReducedReleaseMotion = (): boolean =>
  useSyncExternalStore(subscribeToReducedMotion, reducedMotionSnapshot, () => true)
