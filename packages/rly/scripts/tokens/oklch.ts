import * as Data from "effect/Data"

/** An OKLCH colour as rly's token source writes it: `oklch(L% C H)`, hue `none` for a neutral. */
export type OklchColor = `oklch(${string})`

/** A colour in the OKLab space, the cartesian form of OKLCH. */
export interface Oklab {
  readonly a: number
  readonly b: number
  readonly l: number
}

const OKLCH = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)\s*\)$/

/** A token source value that is not a readable `oklch(L% C H)` literal. */
export class OklchParseError extends Data.TaggedError("OklchParseError")<{ readonly value: string }> {
  override get message(): string {
    return `Invalid oklch() colour: ${this.value}`
  }
}

/** Read an `oklch(L% C H)` literal into OKLab. */
export const oklchToOklab = (value: string): Oklab => {
  const match = OKLCH.exec(value)
  if (match === null) throw new OklchParseError({ value })
  const l = Number(match[1]) / 100
  const chroma = Number(match[2])
  const hue = match[3] === "none" ? 0 : (Number(match[3]) * Math.PI) / 180
  return { a: chroma * Math.cos(hue), b: chroma * Math.sin(hue), l }
}

const toLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
const fromLinear = (value: number): number => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055

/** Linear sRGB channels (0-1, unclamped) for an OKLab colour. */
export const oklabToLinearSrgb = ({ a, b, l }: Oklab): readonly [number, number, number] => {
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b
  ].map(
    (value) => value ** 3
  )
  const [lc = 0, mc = 0, sc = 0] = lms
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc
  ]
}

const channel = (hex: string, offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255

/** OKLab for an opaque six-digit sRGB hex colour. */
export const hexToOklab = (hex: string): Oklab => {
  const [r, g, bl] = [channel(hex, 1), channel(hex, 3), channel(hex, 5)].map(toLinear)
  const red = r ?? 0
  const green = g ?? 0
  const blue = bl ?? 0
  const lms = [
    0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
    0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
    0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue
  ].map(Math.cbrt)
  const [lc = 0, mc = 0, sc = 0] = lms
  return {
    a: 1.9779984951 * lc - 2.428592205 * mc + 0.4505937099 * sc,
    b: 0.0259040371 * lc + 0.7827717662 * mc - 0.808675766 * sc,
    l: 0.2104542553 * lc + 0.793617785 * mc - 0.0040720468 * sc
  }
}

/** The six-digit sRGB hex an OKLCH literal displays as (gamut-clamped, as browsers render it). */
export const oklchToHex = (value: string): string =>
  `#${
    oklabToLinearSrgb(oklchToOklab(value))
      .map((linear) => Math.round(Math.min(1, Math.max(0, fromLinear(linear))) * 255))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  }`

/** Distance between two colours in OKLab (ΔEOK); 0.02 is about one just-noticeable difference. */
export const deltaEOk = (left: Oklab, right: Oklab): number =>
  Math.hypot(left.l - right.l, left.a - right.a, left.b - right.b)
