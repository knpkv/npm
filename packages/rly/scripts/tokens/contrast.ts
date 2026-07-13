import type { ColorTokenSource, ContrastPairSource } from "../../src/tokens/model.js"

const channel = (hex: string, offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255

const linear = (value: number): number => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4

/** WCAG relative luminance for an opaque six-digit sRGB color. */
export const relativeLuminance = (hex: string): number => {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid sRGB color: ${hex}`)
  return 0.2126 * linear(channel(hex, 1)) + 0.7152 * linear(channel(hex, 3))
    + 0.0722 * linear(channel(hex, 5))
}

/** WCAG contrast ratio, with the lighter color first. */
export const contrastRatio = (left: string, right: string): number => {
  const first = relativeLuminance(left)
  const second = relativeLuminance(right)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

export interface ContrastResult {
  readonly minimum: number
  readonly name: string
  readonly ratio: number
  readonly scheme: "light" | "dark"
}

/** Resolve and calculate every declared contrast invariant in both schemes. */
export const measureContrastPairs = (
  colors: ReadonlyArray<ColorTokenSource>,
  pairs: ReadonlyArray<ContrastPairSource>
): ReadonlyArray<ContrastResult> => {
  const byName = new Map(colors.map((color) => [color.name, color]))
  const schemes: ReadonlyArray<"light" | "dark"> = ["light", "dark"]
  return pairs.flatMap((pair) => {
    const foreground = byName.get(pair.foreground)
    const background = byName.get(pair.background)
    if (foreground === undefined || background === undefined) {
      throw new Error(`Unknown contrast token in ${pair.name}`)
    }
    return schemes.map((scheme) => ({
      minimum: pair.minimum,
      name: pair.name,
      ratio: contrastRatio(foreground[scheme], background[scheme]),
      scheme
    }))
  })
}
