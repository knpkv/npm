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

const HOUR_MILLIS = 3_600_000
const STEP_HOURS = [1, 2, 3, 6, 12, 24, 48, 168, 336, 720]

const hourLabel = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" })
const dayLabel = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" })

export interface TimeTick {
  readonly at: number
  readonly label: string
}

/**
 * Time-axis ticks on local hour or midnight boundaries, at the finest step of at least
 * `minStepHours` that leaves `minSpacing` pixels between labels. Midnight in an hourly axis is
 * labelled with its date; day ranges pass 24 so they show whole days only.
 */
export const timeTicks = (
  range: { readonly from: number; readonly to: number },
  width: number,
  minSpacing: number,
  minStepHours = 1
): ReadonlyArray<TimeTick> => {
  const plotWidth = Math.max(1, width - PLOT.left - PLOT.right)
  const span = Math.max(1, range.to - range.from)
  const stepHours =
    STEP_HOURS.find((hours) => hours >= minStepHours && (hours * HOUR_MILLIS * plotWidth) / span >= minSpacing) ??
      STEP_HOURS[STEP_HOURS.length - 1] ?? 720
  const cursor = new Date(range.from)
  cursor.setMinutes(0, 0, 0)
  if (stepHours >= 24) cursor.setHours(0)
  const ticks: Array<TimeTick> = []
  while (cursor.getTime() <= range.to) {
    const at = cursor.getTime()
    const aligned = stepHours >= 24 || cursor.getHours() % stepHours === 0
    if (at >= range.from && aligned) {
      ticks.push({ at, label: stepHours < 24 && cursor.getHours() !== 0 ? hourLabel.format(at) : dayLabel.format(at) })
    }
    if (stepHours >= 24) cursor.setDate(cursor.getDate() + stepHours / 24)
    else cursor.setHours(cursor.getHours() + (aligned ? stepHours : 1))
  }
  return ticks
}
