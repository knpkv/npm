/** One web font rly's styles.css loads: its CSS family and the woff2 file a shell preloads. */
export interface RlyFontFace {
  readonly family: string
  readonly file: string
}

/**
 * Every web font rly's styles.css loads, as Fontsource names the files. The faces use
 * `font-display: optional`, so a shell must preload each of these files (from its own origin, with
 * `crossorigin`) for Geist to render on first load; otherwise the metric-matched fallback stays for
 * that page view and nothing swaps. Shells read this list instead of hardcoding file names.
 */
export const RLY_FONT_FACES: readonly [RlyFontFace, RlyFontFace] = [
  { family: "Geist Variable", file: "geist-latin-wght-normal.woff2" },
  { family: "Geist Mono Variable", file: "geist-mono-latin-wght-normal.woff2" }
]
