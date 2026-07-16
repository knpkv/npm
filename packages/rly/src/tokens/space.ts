import type { LengthTokenSource } from "./model.js"

const defineSpace = <const Tokens extends ReadonlyArray<LengthTokenSource>>(tokens: Tokens): Tokens => tokens

export const spaceTokenSource = defineSpace([
  { name: "0", value: "0" },
  { name: "2", value: "2px" },
  { name: "4", value: "4px" },
  { name: "6", value: "6px" },
  { name: "8", value: "8px" },
  { name: "12", value: "12px" },
  { name: "16", value: "16px" },
  { name: "20", value: "20px" },
  { name: "24", value: "24px" },
  { name: "32", value: "32px" },
  { name: "40", value: "40px" },
  { name: "48", value: "48px" },
  { name: "64", value: "64px" },
  { name: "80", value: "80px" },
  { name: "96", value: "96px" }
])
