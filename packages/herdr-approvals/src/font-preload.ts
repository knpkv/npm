/**
 * rly's Geist faces, UI and mono, as the stylesheet build names them (esbuild `assetNames: "[name]"`).
 * Both are preloaded: the mono face sets ids and kickers, and loading it late re-wrapped a line in
 * the Approvals detail at 390 (CLS 0.069).
 */
export const PRELOADED_FONTS: readonly [string, string] = [
  "geist-latin-wght-normal.woff2",
  "geist-mono-latin-wght-normal.woff2"
]

/**
 * Preloads for the Geist files this host actually serves, so first text paints in Geist rather than
 * the fallback. Built from the fonts scraped out of index.css, so it never names a file /assets/
 * would 404; a face the stylesheet doesn't carry gets no preload.
 */
export const fontPreloadLink = (fonts: ReadonlyMap<string, Uint8Array>): string =>
  PRELOADED_FONTS.filter((font) => fonts.has(font))
    .map((font) => `<link rel="preload" href="/assets/${font}" as="font" type="font/woff2" crossorigin>\n`)
    .join("")
