import postcss, { type Declaration, type Rule } from "postcss"

/** Why a focus rule fails the one-ring policy. */
export type FocusRingRule = "focus-outline" | "focus-offset" | "focus-shadow"

/** One focus declaration that does not draw the rly ring. */
export interface FocusRingViolation {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly rule: FocusRingRule
  readonly declaration: string
}

const FOCUS_SELECTOR = /:focus(?:-visible|-within)?(?![\w-])/
const FORCED_COLOURS_SELECTOR = /data-(?:rly-)?forced-colors/
const WIDTH = /var\(\s*--rly-focus-ring-width\s*\)/
const COLOUR = /var\(\s*--rly-color-focus\s*\)/
const NO_OUTLINE = /^(?:none|0|0px)$/i
// `:not(...)` arguments are dropped first: `.a:focus:not(:focus-visible)` is the mouse-focus state.
const VISIBLE_FOCUS = (selector: string): boolean => /:focus-visible/.test(selector.replace(/:not\([^()]*\)/g, ""))
// The offset token outside the control, the ring's width pulled inside, or flush.
const OFFSETS = [
  /^var\(\s*--rly-focus-ring-offset\s*\)$/,
  /^calc\(\s*var\(\s*--rly-focus-ring-width\s*\)\s*\*\s*-1\s*\)$/,
  /^calc\(\s*-1\s*\*\s*var\(\s*--rly-focus-ring-width\s*\)\s*\)$/,
  /^0(?:px)?$/
]

/** Forced colours draw their own system ring (Highlight, CanvasText), so those blocks are exempt. */
const inForcedColours = (rule: Rule): boolean => {
  if (FORCED_COLOURS_SELECTOR.test(rule.selector)) return true
  for (let node = rule.parent; node !== undefined && node.type !== "root"; node = node.parent) {
    if (node.type === "atrule" && node.name === "media" && /forced-colors\s*:\s*active/.test(node.params)) return true
  }
  return false
}

const verdict = (declaration: Declaration): FocusRingRule | undefined => {
  const value = declaration.value.trim()
  switch (declaration.prop.toLowerCase()) {
    case "outline":
      return NO_OUTLINE.test(value) || (WIDTH.test(value) && COLOUR.test(value)) ? undefined : "focus-outline"
    case "outline-width":
      return NO_OUTLINE.test(value) || WIDTH.test(value) ? undefined : "focus-outline"
    case "outline-color":
      return COLOUR.test(value) ? undefined : "focus-outline"
    case "outline-offset":
      return OFFSETS.some((offset) => offset.test(value)) ? undefined : "focus-offset"
    case "box-shadow":
      return /^none$/i.test(value) ? undefined : "focus-shadow"
    default:
      return undefined
  }
}

/**
 * Every focus indicator is the one rly ring: in a `:focus`, `:focus-visible` or `:focus-within`
 * rule outside forced colours, an outline takes `--rly-focus-ring-width` and `--rly-color-focus`,
 * its offset is the offset token or the negated width, no later `outline: none` erases it, a
 * `:focus-visible` rule never removes the outline without drawing the ring, and no box-shadow
 * stands in for the ring.
 * Rules are matched by selector, so a ring in any other colour cannot slip past.
 */
export const findFocusRingViolations = (path: string, source: string): ReadonlyArray<FocusRingViolation> => {
  const violations: Array<FocusRingViolation> = []
  postcss.parse(source).walkRules((rule) => {
    if (!FOCUS_SELECTOR.test(rule.selector) || inForcedColours(rule)) return
    // Keyboard focus must show the ring, so a :focus-visible rule may only remove an outline it redraws.
    // Plain :focus may drop it (a tabIndex=-1 target, or a parent :focus-within ring).
    const drawsRing = rule.nodes.some((node) =>
      node.type === "decl" && node.prop.toLowerCase() === "outline" && !NO_OUTLINE.test(node.value.trim())
    )
    const keyboardFocus = VISIBLE_FOCUS(rule.selector)
    let ringDrawn = false
    for (const node of rule.nodes) {
      if (node.type !== "decl") continue
      const prop = node.prop.toLowerCase()
      const removesOutline = (prop === "outline" || prop === "outline-width") && NO_OUTLINE.test(node.value.trim())
      const failed = removesOutline && (ringDrawn || (keyboardFocus && !drawsRing)) ? "focus-outline" : verdict(node)
      if (prop === "outline" && !removesOutline) ringDrawn = true
      const start = node.source?.start
      if (failed === undefined || start === undefined) continue
      violations.push({
        column: start.column,
        declaration: `${node.prop}: ${node.value}`,
        line: start.line,
        path,
        rule: failed
      })
    }
  })
  return violations
}
