/**
 * Detects one-sided accent stripes in CSS: a coloured or thick bar on one edge of a card, row,
 * notice or panel (`border-inline-start: 4px solid var(--rly-color-held-ink)`, or the same bar
 * drawn as `box-shadow: inset 3px 0 0 …`). Severity and state belong in words, an even border or a
 * flat tint, never a side bar.
 *
 * Allowed on purpose: 1px dividers that use no accent colour (`border-1`/`border-2`/`transparent`),
 * zeroed sides (`0`, `none`), full inset rings (`inset 0 0 0 2px …`), and blurred or spread insets.
 */

export interface AccentStripeViolation {
  readonly column: number
  readonly line: number
  readonly path: string
  readonly declaration: string
}

const ONE_SIDE = String.raw`border-(?:left|right|inline-start|inline-end)`
const DECLARATION = new RegExp(String.raw`(${ONE_SIDE}(?:-width|-color)?|box-shadow)\s*:\s*([^;}]+)`, "gi")
// Any rly colour except the neutral divider borders; matched anywhere in the value, so an accent
// mixed with `transparent` still counts.
const ACCENT_COLOR = /var\(\s*--rly-(?:color-(?!border-[12]\b)[a-z0-9-]+|verdict-[a-z0-9-]+)/i
const ZEROED = /^\s*(?:0|none|0px|var\(--rly-space-0\))\s*$/i
const THICK = /(?:^|\s)(?:[2-9]|\d{2,}|1\.\d*[1-9])(?:\.\d+)?px\b|var\(\s*--rly-space-(?!0\b)\d+\s*\)/i
const LENGTH = /^(?:-?\d*\.?\d+(?:px|rem|em)?|var\(\s*--rly-space-\d+\s*\))$/i
const ZERO_LENGTH = /^(?:-?0*\.?0+(?:px|rem|em)?|var\(\s*--rly-space-0\s*\))$/i

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))

const position = (source: string, offset: number) => {
  const lines = source.slice(0, offset).split("\n")
  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length }
}

/** Splits a value on top-level separators, keeping `var(...)` and `color-mix(...)` whole. */
const splitTopLevel = (value: string, separator: RegExp): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let depth = 0
  let current = ""
  for (const character of value) {
    if (character === "(") depth += 1
    if (character === ")") depth -= 1
    if (depth === 0 && separator.test(character)) {
      if (current.trim().length > 0) parts.push(current.trim())
      current = ""
    } else current += character
  }
  if (current.trim().length > 0) parts.push(current.trim())
  return parts
}

/**
 * An inset shadow layer drawn as a bar on an inline edge, in any token order: a non-zero horizontal
 * offset, no vertical offset, and no blur or spread (`inset 3px 0`, `inset 3px 0 0 c`,
 * `c inset -3px 0`). Full rings (`inset 0 0 0 2px`), soft blurred insets, and block-edge
 * underlines (a pressed tab) pass, matching the border rule, which checks inline sides only.
 */
const isOneSidedInset = (layer: string): boolean => {
  const tokens = splitTopLevel(layer, /\s/)
  if (!tokens.some((token) => token.toLowerCase() === "inset")) return false
  const [x, y, blur, spread] = tokens.filter((token) => LENGTH.test(token))
  if (x === undefined || y === undefined) return false
  const flat = (length: string | undefined): boolean => length === undefined || ZERO_LENGTH.test(length)
  return !ZERO_LENGTH.test(x) && ZERO_LENGTH.test(y) && flat(blur) && flat(spread)
}

const isStripe = (property: string, value: string): boolean => {
  const name = property.toLowerCase()
  if (name === "box-shadow") return splitTopLevel(value, /,/).some(isOneSidedInset)
  if (ZEROED.test(value)) return false
  if (name.endsWith("-color")) return ACCENT_COLOR.test(value)
  if (name.endsWith("-width")) return THICK.test(value)
  return THICK.test(value) || ACCENT_COLOR.test(value)
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
