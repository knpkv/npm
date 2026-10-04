/**
 * The time axis both charts share, so a usage column and the limit readings beside it line up.
 *
 * @module
 */
export const PLOT = { left: 56, right: 16, top: 12, bottom: 28 }

export interface TimeAxis {
  readonly width: number
  readonly x: (instant: number) => number
  readonly instantAt: (pixel: number) => number
}

export const timeAxis = (range: { readonly from: number; readonly to: number }, width: number): TimeAxis => {
  const plotWidth = Math.max(1, width - PLOT.left - PLOT.right)
  const span = Math.max(1, range.to - range.from)
  return {
    width,
    x: (instant) => PLOT.left + ((instant - range.from) / span) * plotWidth,
    instantAt: (pixel) => range.from + ((pixel - PLOT.left) / plotWidth) * span
  }
}

/** Four round steps from zero to just above `max`. */
export const niceTicks = (max: number): ReadonlyArray<number> => {
  if (max <= 0) return [0]
  const rough = max / 4
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ??
    rough
  return [0, step, step * 2, step * 3, step * 4]
}
