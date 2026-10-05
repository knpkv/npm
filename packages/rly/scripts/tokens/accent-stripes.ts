/**
 * Detects one-sided accent stripes in CSS: a coloured or thick bar on one edge of a card, row,
 * notice or panel (`border-inline-start: 4px solid var(--rly-color-held-ink)`, or the same bar
 * drawn as `box-shadow: inset 3px 0 0 …`). Severity and state belong in words, an even border or a
 * flat tint, never a side bar.
 *
 * Allowed on purpose: 1px neutral dividers between columns (`border-1`/`border-2`/`transparent`),
 * zeroed sides (`0`, `none`), and full inset rings (`inset 0 0 0 2px …`).
 */

export interface AccentStripeViolation {
  readonly column: number
  readonly line: number
  readonly path: string
  readonly declaration: string
}

const ONE_SIDE = String.raw`border-(?:left|right|inline-start|inline-end)`
const DECLARATION = new RegExp(String.raw`(${ONE_SIDE}(?:-width|-color)?|box-shadow)\s*:\s*([^;}]+)`, "gi")
const NEUTRAL_COLOR = /var\(\s*--rly-color-border-[12]\s*\)|transparent|currentcolor/i
const ACCENT_COLOR = /var\(\s*--rly-(?:color-(?!border-[12]\b)[a-z0-9-]+|verdict-[a-z0-9-]+)/i
const ZEROED = /^\s*(?:0|none|0px|var\(--rly-space-0\))\s*$/i
const THICK = /(?:^|\s)(?:[2-9]|\d{2,}|1\.\d*[1-9])(?:\.\d+)?px\b|var\(\s*--rly-space-(?!0\b)\d+\s*\)/i
const ONE_SIDED_INSET =
  /inset\s+(-?\d*\.?\d+(?:px|rem)|var\([^)]*\))\s+0(?:px)?\s+0(?:px)?(?!\s+(?:-?\d|var\(\s*--rly-space))/i

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))

const position = (source: string, offset: number) => {
  const lines = source.slice(0, offset).split("\n")
  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length }
}

const isStripe = (property: string, value: string): boolean => {
  const name = property.toLowerCase()
  if (name === "box-shadow") return ONE_SIDED_INSET.test(value) && !/^\s*inset\s+0\b/i.test(value)
  if (ZEROED.test(value)) return false
  if (name.endsWith("-color")) return ACCENT_COLOR.test(value) && !NEUTRAL_COLOR.test(value)
  if (name.endsWith("-width")) return THICK.test(value)
  return THICK.test(value) || (ACCENT_COLOR.test(value) && !NEUTRAL_COLOR.test(value))
}

/** Every one-sided accent stripe declared in a CSS source, with its 1-based position. */
export const findAccentStripes = (path: string, source: string): ReadonlyArray<AccentStripeViolation> => {
  const comparable = stripComments(source)
  const violations: Array<AccentStripeViolation> = []
  for (const match of comparable.matchAll(DECLARATION)) {
    const [declaration, property, value] = match
    if (property === undefined || value === undefined || declaration === undefined) continue
    if (!isStripe(property, value)) continue
    violations.push({ ...position(comparable, match.index), declaration: declaration.trim(), path })
  }
  return violations
}
