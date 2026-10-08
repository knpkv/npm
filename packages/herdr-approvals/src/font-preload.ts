import { RLY_FONT_FACES } from "@knpkv/rly/tokens"

/** The Geist woff2 files to preload: rly's own list of every face its styles load. */
export const PRELOADED_FONTS: ReadonlyArray<string> = RLY_FONT_FACES.map(({ file }) => file)

/**
 * Preloads for the Geist files this host actually serves, so first text paints in Geist rather than
 * the fallback. Built from the fonts scraped out of index.css, so it never names a file /assets/
 * would 404; a face the stylesheet doesn't carry gets no preload.
 */
export const fontPreloadLink = (fonts: ReadonlyMap<string, Uint8Array>): string =>
  PRELOADED_FONTS.filter((font) => fonts.has(font))
    .map((font) => `<link rel="preload" href="/assets/${font}" as="font" type="font/woff2" crossorigin>\n`)
    .join("")
