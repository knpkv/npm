import type { EasingTokenSource, MotionTokenSource } from "./model.js"

const defineMotion = <const Tokens extends ReadonlyArray<MotionTokenSource>>(tokens: Tokens): Tokens => tokens
const defineEasing = <const Tokens extends ReadonlyArray<EasingTokenSource>>(tokens: Tokens): Tokens => tokens

const easeOut = "cubic-bezier(.2, .8, .2, 1)"

/**
 * The two curves rly moves with. `out` is for things that enter, leave or answer a press: fast first,
 * settling at the end. `in-out` is for something already on screen changing place or turning, like a
 * chevron. There is no ease-in: starting slow reads as lag.
 */
export const easingTokenSource = defineEasing([
  { name: "out", value: easeOut },
  { name: "in-out", value: "cubic-bezier(.65, 0, .35, 1)" }
])

/** Durations top out at 300ms; each keeps the ease-out curve as its paired easing for older consumers. */
export const motionTokenSource = defineMotion([
  { name: "fast", duration: "90ms", reducedDuration: "0ms", easing: easeOut },
  { name: "standard", duration: "160ms", reducedDuration: "0ms", easing: easeOut },
  { name: "deliberate", duration: "240ms", reducedDuration: "0ms", easing: easeOut },
  { name: "slow", duration: "300ms", reducedDuration: "0ms", easing: easeOut }
])
