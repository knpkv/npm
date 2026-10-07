/**
 * Detects lengths measured in a glyph of the current font: `ch` (the "0"), `ex` (the x-height),
 * `cap` and `ic`. They change size when Geist swaps in over its fallback (Geist's "0" is 0.666em,
 * Liberation Sans' 0.574em), so a `68ch` measure narrows the column and every paragraph re-wraps,
 * whatever the fallback's metrics. State the measure in `em` at Geist's ratio (68ch ≈ 45.3em),
 * which keeps the Geist layout and stays put through the swap.
 */
import type { AccentStripeViolation } from "./accent-stripes.js"

// An optional sign belongs to the length (`-2ch`); a hyphen inside an identifier (`.icon-2ch`) does not.
const GLYPH_UNIT = /(?<![\w.-])(-?\d*\.?\d+(?:ch|ex|cap|ic))(?![\w-])/gi

/** Blank comments, strings and `url(...)` arguments, keeping offsets, so only real lengths match. */
const stripNonLengths = (source: string): string =>
  source.replace(
    /\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|url\([^)]*\)/gi,
    (text) => text.replace(/[^\n]/g, " ")
  )

/** Every glyph-relative length, with its 1-based position. */
export const findGlyphUnits = (path: string, source: string): ReadonlyArray<AccentStripeViolation> =>
  [...stripNonLengths(source).matchAll(GLYPH_UNIT)].map((match) => {
    const lines = source.slice(0, match.index).split("\n")
    return { column: (lines.at(-1)?.length ?? 0) + 1, declaration: match[1] ?? "", line: lines.length, path }
  })
