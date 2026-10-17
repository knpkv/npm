import { useCallback, useSyncExternalStore } from "react"

/** The breakpoint where rly switches to its phone layout: dense controls grow to touch size. */
export const COMPACT_VIEWPORT_QUERY = "(max-width: 40rem)"

const mediaQuery = (query: string): MediaQueryList | null => {
  try {
    return window.matchMedia(query)
  } catch {
    return null
  }
}

/**
 * Whether `query` matches now, re-rendering when it changes. `serverSnapshot` is the answer before a window
 * exists (server render and the hydration pass), so pick the value whose first paint is safest.
 */
export const useMediaQuery = (query: string, serverSnapshot: boolean): boolean => {
  const subscribe = useCallback(
    (onChange: () => void): () => void => {
      const list = mediaQuery(query)
      if (list === null) return () => undefined
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    [query]
  )
  // A window without matchMedia answers no, as a non-matching query would.
  const snapshot = useCallback((): boolean => mediaQuery(query)?.matches ?? false, [query])
  return useSyncExternalStore(subscribe, snapshot, () => serverSnapshot)
}
