import * as ts from "typescript"

export type ColorPolicyRule =
  | "raw-color"
  | "primitive-palette"
  | "local-theme"
  | "raw-focus-ring"
  | "inset-focus-offset"

export interface ColorPolicyViolation {
  readonly column: number
  readonly line: number
  readonly path: string
  readonly rule: ColorPolicyRule
}

const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i
const PRIMITIVE_PALETTE = /var\(\s*--(?:rly-)?palette-/i
const COLOR_CONTEXT = /accent|background|border|color|fill|outline|shadow|stroke/i

const ruleForValue = (value: string): ColorPolicyRule | undefined => {
  if (PRIMITIVE_PALETTE.test(value)) return "primitive-palette"
  return RAW_COLOR.test(value) ? "raw-color" : undefined
}

const position = (source: string, offset: number) => {
  const before = source.slice(0, offset)
  const lines = before.split("\n")
  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length }
}

const cssComparable = (source: string): string => {
  let output = ""
  let index = 0
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2)
      const stop = end < 0 ? source.length : end + 2
      output += source.slice(index, stop).replace(/[^\n]/g, " ")
      index = stop
      continue
    }
    const character = source[index]
    if (character === "\"" || character === "'") {
      const quote = character
      let stop = index + 1
      while (stop < source.length) {
        if (source[stop] === "\\") stop += 2
        else if (source[stop] === quote) {
          stop += 1
          break
        } else stop += 1
      }
      output += source.slice(index, stop).replace(/[^\n]/g, " ")
      index = stop
      continue
    }
    output += character
    index += 1
  }
  return output.replace(/url\([^)]*\)/gi, (value) => value.replace(/[^\n]/g, " "))
}

/**
 * The focus-ring rules, shared by rly's colour policy and the repo-wide focus-ring lint: an outline
 * in the focus colour takes its width from the token, and an inset ring negates the width.
 */
const FOCUS_RING_PATTERNS: ReadonlyArray<readonly [RegExp, ColorPolicyRule]> = [
  // One focus ring everywhere: an outline in the focus colour takes its width from the token.
  [/\boutline\s*:(?![^;}]*--rly-focus-ring-width)[^;}]*var\(\s*--rly-color-focus\s*\)/gi, "raw-focus-ring"],
  // An inset ring is the ring's width pulled inside; negating the offset token only matches while both are 2px.
  // It also flags `calc(var(--rly-focus-ring-offset) - 1px)`; offset arithmetic belongs on the width token.
  [
    /\boutline-offset\s*:[^;}]*--rly-focus-ring-offset[^;}]*-\s*1|\boutline-offset\s*:[^;}]*-\s*1[^;}]*--rly-focus-ring-offset|\boutline-offset\s*:\s*calc\(\s*-\s*var\(\s*--rly-focus-ring-offset/gi,
    "inset-focus-offset"
  ]
]

const patternViolations = (
  path: string,
  source: string,
  patterns: ReadonlyArray<readonly [RegExp, ColorPolicyRule]>
): ReadonlyArray<ColorPolicyViolation> => {
  const comparable = cssComparable(source)
  const violations: Array<ColorPolicyViolation> = []
  for (const [pattern, rule] of patterns) {
    for (const match of comparable.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const offset = match.index
      if (offset === undefined) continue
      violations.push({ ...position(source, offset), path, rule })
    }
  }
  return violations
}

const cssViolations = (path: string, source: string): ReadonlyArray<ColorPolicyViolation> =>
  patternViolations(path, source, [
    [new RegExp(RAW_COLOR.source, "gi"), "raw-color"],
    [new RegExp(PRIMITIVE_PALETTE.source, "gi"), "primitive-palette"],
    [/(?:data-theme|prefers-color-scheme|\bcolor-scheme\s*:)/gi, "local-theme"],
    ...FOCUS_RING_PATTERNS
  ])

/** Focus-ring violations only, for product stylesheets that keep their own colours. */
export const findFocusRingViolations = (path: string, source: string): ReadonlyArray<ColorPolicyViolation> =>
  patternViolations(path, source, FOCUS_RING_PATTERNS)

const propertyName = (node: ts.PropertyName | ts.BindingName): string | undefined => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

const scriptViolations = (path: string, source: string): ReadonlyArray<ColorPolicyViolation> => {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations: Array<ColorPolicyViolation> = []
  const report = (node: ts.Node, rule: ColorPolicyRule): void => {
    const location = file.getLineAndCharacterOfPosition(node.getStart(file))
    violations.push({ column: location.character + 1, line: location.line + 1, path, rule })
  }
  const inspectText = (node: ts.Node, name: string | undefined, value: string): void => {
    if (name === undefined || !COLOR_CONTEXT.test(name)) return
    const rule = ruleForValue(value)
    if (rule !== undefined) report(node, rule)
  }
  const inspectExpression = (expression: ts.Expression, name: string | undefined): void => {
    if (name === undefined || !COLOR_CONTEXT.test(name)) return
    const inspectNode = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        inspectText(node, name, node.text)
      }
      ts.forEachChild(node, inspectNode)
    }
    inspectNode(expression)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      inspectExpression(node.initializer, propertyName(node.name))
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer
      if (initializer !== undefined) inspectExpression(initializer, node.name.text)
    } else if (ts.isJsxAttribute(node) && node.initializer !== undefined) {
      const name = node.name.getText(file)
      if (ts.isStringLiteral(node.initializer)) inspectExpression(node.initializer, name)
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) {
        inspectExpression(node.initializer.expression, name)
      }
    } else if (ts.isTaggedTemplateExpression(node) && node.tag.getText(file) === "css") {
      for (const violation of cssViolations(path, node.template.getText(file))) violations.push(violation)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return violations
}

/** Find forbidden color/theme declarations in one component-owned source file. */
export const findColorPolicyViolations = (path: string, source: string): ReadonlyArray<ColorPolicyViolation> =>
  path.endsWith(".css") ? cssViolations(path, source) : scriptViolations(path, source)
