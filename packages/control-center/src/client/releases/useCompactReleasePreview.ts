import { useSyncExternalStore } from "react"

const COMPACT_RELEASE_PREVIEW_QUERY = "(max-width: 40rem)"

const mediaQuery = (): MediaQueryList | null =>
  typeof window === "undefined" ? null : window.matchMedia(COMPACT_RELEASE_PREVIEW_QUERY)

const subscribe = (onChange: () => void): () => void => {
  const query = mediaQuery()
  if (query === null) return () => undefined
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

const snapshot = (): boolean => mediaQuery()?.matches ?? false

/** Select the full-screen compact release sheet at the same breakpoint as rly release rows. */
export const useCompactReleasePreview = (): boolean => useSyncExternalStore(subscribe, snapshot, () => false)
