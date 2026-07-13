/** A semantic color pair selected by the inherited CSS color scheme. */
export interface ColorTokenSource {
  readonly dark: `#${string}`
  readonly forced: string
  readonly light: `#${string}`
  readonly name: string
  readonly purpose: "content" | "state" | "provenance"
}

/** A named typography role. */
export interface TypeTokenSource {
  readonly font: "ui" | "mono"
  readonly lineHeight: string
  readonly name: string
  readonly size: string
  readonly tracking: string
  readonly weight: number
}

/** A scalar CSS length token. */
export interface LengthTokenSource {
  readonly name: string
  readonly value: `${number}px` | "0"
}

/** A motion duration/easing pair with an explicit reduced-motion value. */
export interface MotionTokenSource {
  readonly duration: `${number}ms`
  readonly easing: string
  readonly name: string
  readonly reducedDuration: `${number}ms`
}

/** One contrast invariant checked for both light and dark schemes. */
export interface ContrastPairSource {
  readonly background: string
  readonly foreground: string
  readonly minimum: 3 | 4.5 | 7
  readonly name: string
}
