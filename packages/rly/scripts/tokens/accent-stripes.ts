/**
 * Detects one-sided accent stripes in CSS: a coloured or thick bar on one edge of a card, row,
 * notice or panel (`border-inline-start: 4px solid var(--rly-color-held-ink)`, or the same bar
 * drawn as `box-shadow: inset 3px 0 0 …`). Severity and state belong in words, an even border or a
 * flat tint, never a side bar.
 *
 * A side border is allowed only when it is zeroed (`0`, `none`) or a hairline (1px or less) in a
 * neutral divider colour (`border-1`, `border-2`, `transparent`); anything else counts as a stripe,
 * whatever unit or colour spelling it uses. Inset shadows are allowed as full rings
 * (`inset 0 0 0 2px …`), blurred or spread insets, and block-edge underlines; an inset whose offsets
 * cannot be read (`calc(…)`, an unknown variable) is treated as a stripe. A `border-width` list with
 * exactly one edge thicker than a hairline is a stripe too, however the colour is set.
 *
 * A drawn shape that needs a thick edge (a chevron made of two edges of a rotated square) opts out
 * per declaration with a reasoned comment on the same line: `/* stripe-ok: drawn chevron *\/`.
 */

export interface AccentStripeViolation {
  readonly column: number
  readonly line: number
  readonly path: string
  readonly declaration: string
}

const ONE_SIDE = String.raw`border-(?:left|right|inline-start|inline-end)`
const DECLARATION = new RegExp(String.raw`(${ONE_SIDE}(?:-width|-color)?|border-width|box-shadow)\s*:\s*([^;}]+)`, "gi")
const EXEMPT = /\/\*\s*stripe-ok:\s*\S[^*]*\*\//
const ZEROED = /^\s*(?:0|none|0px|var\(--rly-space-0\))\s*$/i
const NEUTRAL_COLOR = /^(?:var\(\s*--rly-color-border-[12]\s*\)|transparent)$/i
const HAIRLINE = /^(?:0?\.\d+|1)px$|^(?:0|0px|var\(\s*--rly-space-0\s*\))$/i
const STYLE = /^(?:none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i
const COLOR_TOKEN =
  /^(?:#|rgb|hsl|oklch|oklab|lab|lch|color|color-mix\(|var\(\s*--rly-color-|currentcolor$|transparent$|[a-z]+$)/i
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
  // Offsets are the tokens that are neither `inset` nor a colour; one that cannot be read as a
  // length (calc, an unknown variable) fails closed.
  const offsets = tokens.filter((token) => token.toLowerCase() !== "inset" && !COLOR_TOKEN.test(token))
  if (offsets.some((token) => !LENGTH.test(token))) return true
  const [x, y, blur, spread] = offsets
  if (x === undefined || y === undefined) return false
  const flat = (length: string | undefined): boolean => length === undefined || ZERO_LENGTH.test(length)
  return !ZERO_LENGTH.test(x) && ZERO_LENGTH.test(y) && flat(blur) && flat(spread)
}

/**
 * A side border's parts, in any order: every token a style, a hairline width or a neutral colour,
 * and the width stated, since an omitted width is CSS's `medium`, not a hairline.
 */
const isNeutralHairline = (value: string): boolean => {
  const tokens = splitTopLevel(value.trim(), /\s/)
  const width = tokens.filter((token) => !STYLE.test(token) && !NEUTRAL_COLOR.test(token))
  const colors = tokens.filter((token) => !STYLE.test(token) && !HAIRLINE.test(token))
  return (
    tokens.some((token) => HAIRLINE.test(token)) &&
    width.every((token) => HAIRLINE.test(token)) &&
    colors.every((token) => NEUTRAL_COLOR.test(token))
  )
}

/** `border-width` with one edge thicker than a hairline and every other edge zero. */
const isOneSidedWidth = (value: string): boolean => {
  const [top, right = top, bottom = top, left = right] = splitTopLevel(value.trim(), /\s/)
  const edges = [top, right, bottom, left]
  const thick = edges.filter((edge) => edge !== undefined && !HAIRLINE.test(edge))
  const zero = edges.filter((edge) => edge !== undefined && ZEROED.test(edge))
  return thick.length === 1 && zero.length === 3
}

const isStripe = (property: string, value: string): boolean => {
  const name = property.toLowerCase()
  if (name === "box-shadow") return splitTopLevel(value, /,/).some(isOneSidedInset)
  if (name === "border-width") return isOneSidedWidth(value)
  if (ZEROED.test(value)) return false
  if (name.endsWith("-color")) return !NEUTRAL_COLOR.test(value.trim())
  if (name.endsWith("-width")) return !HAIRLINE.test(value.trim())
  return !isNeutralHairline(value)
}

/** Every one-sided accent stripe declared in a CSS source, with its 1-based position. */
export const findAccentStripes = (path: string, source: string): ReadonlyArray<AccentStripeViolation> => {
  const comparable = stripComments(source)
  const lines = source.split("\n")
  const violations: Array<AccentStripeViolation> = []
  for (const match of comparable.matchAll(DECLARATION)) {
    const [declaration, property, value] = match
    if (property === undefined || value === undefined || declaration === undefined) continue
    if (!isStripe(property, value)) continue
    const at = position(comparable, match.index)
    if (EXEMPT.test(lines[at.line - 1] ?? "")) continue
    violations.push({ ...at, declaration: declaration.trim(), path })
  }
  return violations
}
