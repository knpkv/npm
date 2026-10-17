import { COMPACT_VIEWPORT_QUERY, useMediaQuery } from "../useMediaQuery.js"

/** Select the full-screen compact release sheet at the same breakpoint as rly release rows. */
export const useCompactReleasePreview = (): boolean => useMediaQuery(COMPACT_VIEWPORT_QUERY, false)

/** Disable the sole orchestrated release transition when the user requests reduced motion. */
export const usePrefersReducedReleaseMotion = (): boolean => useMediaQuery("(prefers-reduced-motion: reduce)", true)
