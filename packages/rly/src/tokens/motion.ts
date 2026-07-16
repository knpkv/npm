import type { MotionTokenSource } from "./model.js"

const defineMotion = <const Tokens extends ReadonlyArray<MotionTokenSource>>(tokens: Tokens): Tokens => tokens

export const motionTokenSource = defineMotion([
  { name: "fast", duration: "90ms", reducedDuration: "0ms", easing: "cubic-bezier(.2, .8, .2, 1)" },
  { name: "standard", duration: "160ms", reducedDuration: "0ms", easing: "cubic-bezier(.2, .8, .2, 1)" },
  { name: "deliberate", duration: "240ms", reducedDuration: "0ms", easing: "cubic-bezier(.2, .8, .2, 1)" },
  { name: "slow", duration: "360ms", reducedDuration: "0ms", easing: "cubic-bezier(.2, .8, .2, 1)" }
])
