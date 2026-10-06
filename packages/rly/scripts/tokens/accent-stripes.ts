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
 * cannot be read (`calc(…)`, an unknown variable) is treated as a stripe. A `border-width` or
 * `border-inline-width` list that draws only one inline edge is a stripe when that edge is thicker
 * than a hairline, or when it is a hairline and its rule does not state a neutral border colour.
 * Block-edge underlines (`border-width: 0 0 2px`) pass, like block-edge insets.
 *
 * A drawn shape that needs a thick edge (a chevron made of two edges of a rotated square) opts out
 * per declaration with a reasoned comment on the same line: `/* stripe-ok: drawn chevron *\/`.
 */

import postcss, { type Declaration, type Rule } from "postcss"

export interface AccentStripeViolation {
  readonly column: number
  readonly line: number
  readonly path: string
  readonly declaration: string
}

const ONE_SIDE = String.raw`border-(?:left|right|inline-start|inline-end)`
const DECLARATION_NAME = new RegExp(
  String.raw`^(?:${ONE_SIDE}(?:-width|-color)?|border-inline-width|border-width|box-shadow)$`,
  "i"
)
const RULE_COLOR =
  /(?:^|[;{\s])(border(?:-color|-(?:left|right|inline-start|inline-end|inline)-color)?)\s*:\s*([^;}]+)/gi
const ZEROED = /^\s*(?:0|none|0px|var\(--rly-space-0\))\s*$/i
const NEUTRAL_COLOR = /^(?:var\(\s*--rly-color-border-[12]\s*\)|transparent)$/i
const HAIRLINE = /^(?:0?\.\d+|1)px$|^(?:0|0px|var\(\s*--rly-space-0\s*\))$/i
const STYLE = /^(?:none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i
const COLOR_TOKEN =
  /^(?:#|rgb|hsl|oklch|oklab|lab|lch|color|color-mix\(|var\(\s*--rly-color-|currentcolor$|transparent$|[a-z]+$)/i
const LENGTH = /^(?:-?\d*\.?\d+(?:px|rem|em)?|var\(\s*--rly-space-\d+\s*\))$/i
const ZERO_LENGTH = /^(?:-?0*\.?0+(?:px|rem|em)?|var\(\s*--rly-space-0\s*\))$/i

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
  if (ZERO_LENGTH.test(x) || !ZERO_LENGTH.test(y) || !flat(blur) || !flat(spread)) return false
  // A 1px bar in a neutral divider colour is a column divider, allowed as it is for borders.
  const colors = tokens.filter((token) => token.toLowerCase() !== "inset" && COLOR_TOKEN.test(token))
  const hairline = HAIRLINE.test(x.replace(/^-/, ""))
  return !(hairline && colors.length > 0 && colors.every((color) => NEUTRAL_COLOR.test(color)))
}

/**
 * A side border's parts, in any order: every token a style, a hairline width or a neutral colour,
 * and the width stated, since an omitted width is CSS's `medium`, not a hairline.
 */
const isNeutralHairline = (value: string): boolean => {
  const tokens = splitTopLevel(value.trim(), /\s/)
  const width = tokens.filter((token) => !STYLE.test(token) && !NEUTRAL_COLOR.test(token))
  const colors = tokens.filter((token) => !STYLE.test(token) && !HAIRLINE.test(token))
  // The colour must be stated too: an omitted one is currentColor, which is whatever the text is.
  return (
    tokens.some((token) => HAIRLINE.test(token)) &&
    tokens.some((token) => NEUTRAL_COLOR.test(token)) &&
    width.every((token) => HAIRLINE.test(token)) &&
    colors.every((token) => NEUTRAL_COLOR.test(token))
  )
}

/**
 * A width list's edges, each marked inline or not: `border-width` lists top/right/bottom/left,
 * `border-inline-width` lists start/end.
 */
const widthEdges = (
  property: string,
  value: string
): ReadonlyArray<{ readonly width: string; readonly inline: boolean }> => {
  const [first = "0", second = first, third = first, fourth = second] = splitTopLevel(value.trim(), /\s/)
  return property === "border-inline-width"
    ? [{ inline: true, width: first }, { inline: true, width: second }]
    : [
      { inline: false, width: first },
      { inline: true, width: second },
      { inline: false, width: third },
      { inline: true, width: fourth }
    ]
}

/** A value without its `!important` priority, which says nothing about what the border draws. */
const withoutPriority = (value: string): string => value.replace(/\s*!\s*important\s*$/i, "")

/** Whether a rule states its border colour, and every colour it states is a neutral divider. */
const statesNeutralColor = (rule: string): boolean => {
  const colors = [...rule.matchAll(RULE_COLOR)].flatMap(([, property, raw]) => {
    if (property === undefined || raw === undefined) return []
    const value = withoutPriority(raw.trim())
    return property.toLowerCase() === "border"
      ? splitTopLevel(value, /\s/).filter((token) => !STYLE.test(token) && !LENGTH.test(token))
      : splitTopLevel(value, /\s/)
  })
  return colors.length > 0 && colors.every((color) => NEUTRAL_COLOR.test(color))
}

/**
 * A width list that marks one inline edge: the only edge thicker than a hairline, or the only edge
 * drawn at all while its rule leaves the colour unstated or coloured. A thick block edge alone is an
 * underline and passes.
 */
const isOneSidedWidth = (property: string, value: string, rule: string): boolean => {
  const edges = widthEdges(property, value)
  const thick = edges.filter((edge) => !HAIRLINE.test(edge.width))
  if (thick.length === 1) return thick[0]?.inline === true
  const drawn = edges.filter((edge) => !ZERO_LENGTH.test(edge.width))
  return thick.length === 0 && drawn.length === 1 && drawn[0]?.inline === true && !statesNeutralColor(rule)
}

const isStripe = (property: string, value: string, rule: string): boolean => {
  const name = property.toLowerCase()
  if (name === "box-shadow") return splitTopLevel(value, /,/).some(isOneSidedInset)
  if (name === "border-width" || name === "border-inline-width") return isOneSidedWidth(name, value, rule)
  if (ZEROED.test(value)) return false
  if (name.endsWith("-color")) return !NEUTRAL_COLOR.test(value.trim())
  // A side width alone draws in the rule's colour, so a hairline passes only with a neutral one stated.
  if (name.endsWith("-width")) return !HAIRLINE.test(value.trim()) || !statesNeutralColor(rule)
  return !isNeutralHairline(value)
}

type EdgeName = "top" | "right" | "bottom" | "left"
const EDGES: ReadonlyArray<EdgeName> = ["top", "right", "bottom", "left"]
const INLINE: ReadonlySet<EdgeName> = new Set(["left", "right"])

/** One edge of a rule's border as its declarations leave it, and the declaration that set it last. */
interface Edge {
  readonly width: string
  readonly style: string
  readonly color: string
  readonly by: Declaration | undefined
}

type EdgePart = "width" | "style" | "color"

/** Which edges a border property name addresses; logical inline sides map to left/right, block to top/bottom. */
const edgesOf = (side: string): ReadonlyArray<EdgeName> => {
  switch (side) {
    case "":
      return EDGES
    case "top":
    case "block-start":
      return ["top"]
    case "bottom":
    case "block-end":
      return ["bottom"]
    case "left":
    case "inline-start":
      return ["left"]
    case "right":
    case "inline-end":
      return ["right"]
    case "inline":
      return ["left", "right"]
    case "block":
      return ["top", "bottom"]
    default:
      return []
  }
}

/** Spreads a 1–4 value list over top/right/bottom/left, or a 1–2 value list over a logical pair. */
const spread = (values: ReadonlyArray<string>, edges: ReadonlyArray<EdgeName>): ReadonlyArray<string> => {
  if (edges.length === 4) {
    const [top = "", right = top, bottom = top, left = right] = values
    return [top, right, bottom, left]
  }
  const [first = "", second = first] = values
  return edges.length === 2 ? [first, second] : [first]
}

/** The width, style and colour parts of a border shorthand, with CSS initial values for omitted parts. */
/** A border shorthand's three parts. */
interface BorderParts {
  readonly width: string
  readonly style: string
  readonly color: string
}

const shorthandParts = (value: string): BorderParts => {
  const tokens = splitTopLevel(value, /\s/)
  return {
    color: tokens.find((token) => !STYLE.test(token) && !LENGTH.test(token) && !/^(?:thin|medium|thick)$/i.test(token))
      ?? "currentcolor",
    style: tokens.find((token) => STYLE.test(token)) ?? "none",
    width: tokens.find((token) => LENGTH.test(token) || /^(?:thin|medium|thick)$/i.test(token)) ?? "medium"
  }
}

/** Applies a rule's own border declarations, in order, to its four edges. */
const ruleEdges = (rule: Rule): ReadonlyMap<EdgeName, Edge> => {
  const edges = new Map<EdgeName, Edge>(
    EDGES.map((name) => [name, { by: undefined, color: "currentcolor", style: "none", width: "medium" }])
  )
  const important = new Set<string>()
  // A later declaration replaces an edge part only when CSS priority lets it: never over !important.
  const set = (name: EdgeName, part: EdgePart, value: string, by: Declaration): void => {
    const edge = edges.get(name)
    const key = `${name}:${part}`
    if (edge === undefined || (important.has(key) && !by.important)) return
    if (by.important) important.add(key)
    edges.set(name, { ...edge, [part]: value, by })
  }
  for (const node of rule.nodes ?? []) {
    if (node.type !== "decl" || node.prop.startsWith("--")) continue
    const match =
      /^border(?:-(top|right|bottom|left|inline-start|inline-end|block-start|block-end|inline|block))?(?:-(width|style|color))?$/i
        .exec(node.prop.toLowerCase())
    if (match === null) continue
    const targets = edgesOf(match[1] ?? "")
    const part = match[2]
    const value = node.value.trim()
    if (part === "width" || part === "style" || part === "color") {
      const values = spread(splitTopLevel(value, /\s/), targets)
      targets.forEach((name, index) => set(name, part, values[index] ?? "", node))
    } else {
      const parts = shorthandParts(value)
      for (const name of targets) {
        set(name, "width", parts.width, node)
        set(name, "style", parts.style, node)
        set(name, "color", parts.color, node)
      }
    }
  }
  return edges
}

const visible = (edge: Edge): boolean =>
  !/^(?:none|hidden)$/i.test(edge.style) && !ZERO_LENGTH.test(edge.width) && !/^transparent$/i.test(edge.color)
const thick = (edge: Edge): boolean => !HAIRLINE.test(edge.width)
const neutral = (edge: Edge): boolean => NEUTRAL_COLOR.test(edge.color)

/**
 * The declaration that makes one inline edge of a rule a stripe, whatever mix of shorthands and
 * longhands draws it: the only visible inline edge when it is thick or coloured, or the one inline
 * edge thicker, or more colourful, than the other visible edges. Block edges alone are underlines.
 */
const edgeStripe = (rule: Rule): Declaration | undefined => {
  const edges = ruleEdges(rule)
  const shown = EDGES.flatMap((name) => {
    const edge = edges.get(name)
    return edge !== undefined && visible(edge) ? [{ edge, name }] : []
  })
  const lone = (items: ReadonlyArray<{ readonly edge: Edge; readonly name: EdgeName }>) =>
    items.length === 1 && items[0] !== undefined && INLINE.has(items[0].name) ? items[0].edge.by : undefined
  if (shown.length === 1) {
    const [only] = shown
    return only !== undefined && INLINE.has(only.name) && (thick(only.edge) || !neutral(only.edge))
      ? only.edge.by
      : undefined
  }
  return lone(shown.filter(({ edge }) => thick(edge)))
    ?? (shown.some(({ edge }) => neutral(edge)) ? lone(shown.filter(({ edge }) => !neutral(edge))) : undefined)
}

const THIN = /^(?:[0-4](?:\.\d+)?px|0?\.\d+px|var\(\s*--rly-space-[024]\s*\))$/i
const NEUTRAL_FILL = /^(?:none|transparent|var\(\s*--rly-color-(?:border-[12]|surface-\d|canvas)\s*\))$/i

/**
 * The declaration that makes a rule a thin coloured bar: an element 4px or narrower whose background
 * is a colour rather than a neutral divider or surface (ServiceMark's old 3px `.rail`). Thin
 * horizontal lines stay allowed, like block-edge borders.
 */
const barStripe = (rule: Rule): Declaration | undefined => {
  const own = (rule.nodes ?? []).flatMap((node) => (node.type === "decl" ? [node] : []))
  const thin = own.find((decl) => /^(?:width|inline-size)$/i.test(decl.prop) && THIN.test(decl.value.trim()))
  const fill = own.find((decl) => /^background(?:-color)?$/i.test(decl.prop))
  if (thin === undefined || fill === undefined) return undefined
  return NEUTRAL_FILL.test(fill.value.trim()) ? undefined : thin
}

/** Whether a declaration carries its own stripe-ok comment (with a reason) right after it on the same line. */
const exempt = (decl: Declaration): boolean => {
  const next = decl.next()
  return next?.type === "comment"
    && next.source?.start?.line === decl.source?.start?.line
    && /^stripe-ok:\s*\S/.test(next.text.trim())
}

/** A rule's own declarations as text (no nested blocks), for reading the border colour it states. */
const ownDeclarations = (decl: Declaration): string =>
  (decl.parent?.nodes ?? []).flatMap((node) => (node.type === "decl" ? [`${node.prop}: ${node.value};`] : [])).join(" ")

/** Every one-sided accent stripe declared in a CSS source, with its 1-based position. */
export const findAccentStripes = (path: string, source: string): ReadonlyArray<AccentStripeViolation> => {
  const violations: Array<AccentStripeViolation> = []
  const report = (by: Declaration): void => {
    const start = by.source?.start
    if (start === undefined || exempt(by)) return
    if (violations.some((seen) => seen.line === start.line && seen.column === start.column)) return
    violations.push({
      column: start.column,
      declaration: `${by.prop}: ${by.value}${by.important ? " !important" : ""}`,
      line: start.line,
      path
    })
  }
  const root = postcss.parse(source)
  // Each declaration on its own (quoted strings and comments are never declarations here)...
  root.walkDecls((decl) => {
    if (decl.prop.startsWith("--") || !DECLARATION_NAME.test(decl.prop)) return
    if (isStripe(decl.prop, decl.value.trim(), ownDeclarations(decl))) report(decl)
  })
  // ...and per rule and edge, so longhands (`border-style: none none none solid`) cannot assemble a stripe.
  root.walkRules((rule) => {
    for (const by of [edgeStripe(rule), barStripe(rule)]) if (by !== undefined) report(by)
  })
  return violations.sort((left, right) => left.line - right.line || left.column - right.column)
}
