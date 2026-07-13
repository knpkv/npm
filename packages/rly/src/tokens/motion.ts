import type { MotionTokenSource } from "./model.js"

const defineMotion = <const Tokens extends ReadonlyArray<MotionTokenSource>>(tokens: Tokens): Tokens => tokens

export const motionTokenSource = defineMotion([
  { name: "instant", duration: "0ms", reducedDuration: "0ms", easing: "linear" },
  { name: "fast", duration: "120ms", reducedDuration: "0ms", easing: "cubic-bezier(.2, 0, 0, 1)" },
  { name: "standard", duration: "180ms", reducedDuration: "0ms", easing: "cubic-bezier(.2, 0, 0, 1)" },
  { name: "deliberate", duration: "260ms", reducedDuration: "0ms", easing: "cubic-bezier(.2, 0, 0, 1)" }
])
