/** rly's Geist UI font, as the stylesheet build names it (esbuild `assetNames: "[name]"`). */
export const PRELOADED_FONT = "geist-latin-wght-normal.woff2"

/**
 * A preload for the Geist file this host actually serves, so first text paints in Geist rather than
 * the fallback. Built from the fonts scraped out of index.css, so it never names a file /assets/
 * would 404; a stylesheet without Geist gets no preload.
 */
export const fontPreloadLink = (fonts: ReadonlyMap<string, Uint8Array>): string =>
  fonts.has(PRELOADED_FONT)
    ? `<link rel="preload" href="/assets/${PRELOADED_FONT}" as="font" type="font/woff2" crossorigin>\n`
    : ""
