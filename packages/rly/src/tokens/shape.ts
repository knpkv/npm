import type { LengthTokenSource } from "./model.js"

const defineContract = <const Tokens extends ReadonlyArray<LengthTokenSource>>(tokens: Tokens): Tokens => tokens

export const radiusTokenSource = defineContract([
  { name: "tag", value: "6px" },
  { name: "field", value: "10px" },
  { name: "control", value: "14px" },
  { name: "group", value: "20px" },
  { name: "overlay", value: "28px" },
  { name: "round", value: "999px" }
])
