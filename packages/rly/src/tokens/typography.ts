import type { TypeTokenSource } from "./model.js"

const defineType = <const Tokens extends ReadonlyArray<TypeTokenSource>>(tokens: Tokens): Tokens => tokens

export const typeTokenSource = defineType([
  { name: "verdict", font: "ui", size: "clamp(3rem, 7vw, 7rem)", lineHeight: ".88", weight: 650, tracking: "-.065em" },
  {
    name: "page-title",
    font: "ui",
    size: "clamp(2.5rem, 4.5vw, 5.25rem)",
    lineHeight: ".94",
    weight: 620,
    tracking: "-.05em"
  },
  { name: "section-title", font: "ui", size: "2rem", lineHeight: "2.25rem", weight: 620, tracking: "-.035em" },
  { name: "card-title", font: "ui", size: "1.25rem", lineHeight: "1.625rem", weight: 620, tracking: "-.02em" },
  { name: "body-large", font: "ui", size: "1.125rem", lineHeight: "1.75rem", weight: 430, tracking: "-.01em" },
  { name: "body", font: "ui", size: "1rem", lineHeight: "1.5rem", weight: 430, tracking: "0" },
  { name: "label", font: "ui", size: ".8125rem", lineHeight: "1.0625rem", weight: 600, tracking: "0" },
  { name: "meta", font: "ui", size: ".75rem", lineHeight: "1rem", weight: 520, tracking: "0" },
  { name: "code", font: "mono", size: ".875rem", lineHeight: "1.25rem", weight: 450, tracking: "0" }
])
