import * as Predicate from "effect/Predicate"
/**
 * Pure helpers for theme resolution.
 *
 * Separated from Resolver.ts to avoid @opentui/core deps in tests.
 *
 * @internal
 */

type HexColor = `#${string}`
type RefName = string
type Variant = {
  readonly dark: HexColor | RefName
  readonly light: HexColor | RefName
}
type ColorValue = HexColor | RefName | Variant

export interface TuiThemeJson {
  readonly defs?: Record<string, HexColor | RefName>
  readonly theme: Record<string, ColorValue>
}

export type ThemeJson = TuiThemeJson

export interface RGBALike {
  readonly r: number
  readonly g: number
  readonly b: number
}

export const rgbaToHex = (rgba: RGBALike): string => {
  const r = Math.round(rgba.r * 255).toString(16).padStart(2, "0")
  const g = Math.round(rgba.g * 255).toString(16).padStart(2, "0")
  const b = Math.round(rgba.b * 255).toString(16).padStart(2, "0")
  return `#${r}${g}${b}`
}

export const isThemeJson = <UnparsedInput>(json: UnparsedInput): json is UnparsedInput & ThemeJson => {
  if (!Predicate.isObjectOrArray(json) || json === null) return false
  return "theme" in json
}
