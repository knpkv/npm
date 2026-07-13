import type { ColorTokenSource, ContrastPairSource } from "./model.js"

const defineColors = <const Tokens extends ReadonlyArray<ColorTokenSource>>(tokens: Tokens): Tokens => tokens
const defineContrastPairs = <const Pairs extends ReadonlyArray<ContrastPairSource>>(pairs: Pairs): Pairs => pairs

/** Private palette values. Components consume only the generated semantic variables. */
export const colorTokenSource = defineColors([
  { name: "canvas", light: "#F6F6F8", dark: "#101114", forced: "Canvas", purpose: "content" },
  { name: "surface-1", light: "#FFFFFF", dark: "#17181C", forced: "Canvas", purpose: "content" },
  { name: "surface-2", light: "#F0F1F4", dark: "#1E2025", forced: "Canvas", purpose: "content" },
  { name: "surface-3", light: "#E8E9ED", dark: "#282A31", forced: "Canvas", purpose: "content" },
  { name: "text-1", light: "#17181B", dark: "#F4F4F6", forced: "CanvasText", purpose: "content" },
  { name: "text-2", light: "#5E6068", dark: "#B7B9C1", forced: "CanvasText", purpose: "content" },
  { name: "text-3", light: "#6E717A", dark: "#9396A0", forced: "CanvasText", purpose: "content" },
  { name: "border-1", light: "#DADCE2", dark: "#30323A", forced: "ButtonBorder", purpose: "content" },
  { name: "border-2", light: "#B9BCC5", dark: "#4C4F5A", forced: "ButtonBorder", purpose: "content" },
  { name: "action-background", light: "#17181B", dark: "#F4F4F6", forced: "ButtonText", purpose: "content" },
  { name: "action-foreground", light: "#FFFFFF", dark: "#17181B", forced: "ButtonFace", purpose: "content" },
  { name: "focus", light: "#006DFF", dark: "#89B7FF", forced: "Highlight", purpose: "content" },
  { name: "agent", light: "#6741A5", dark: "#BD9CF0", forced: "LinkText", purpose: "content" },
  { name: "success-ink", light: "#187A3A", dark: "#66D38B", forced: "CanvasText", purpose: "state" },
  { name: "success-tint", light: "#EAF6ED", dark: "#153222", forced: "Canvas", purpose: "state" },
  { name: "blocked-ink", light: "#B42318", dark: "#FF8B82", forced: "CanvasText", purpose: "state" },
  { name: "blocked-tint", light: "#FDECEA", dark: "#3A1918", forced: "Canvas", purpose: "state" },
  { name: "held-ink", light: "#7A5100", dark: "#F0C66A", forced: "CanvasText", purpose: "state" },
  { name: "held-tint", light: "#FFF5DC", dark: "#33270F", forced: "Canvas", purpose: "state" },
  { name: "deploying-ink", light: "#075EBC", dark: "#75AEFF", forced: "CanvasText", purpose: "state" },
  { name: "deploying-tint", light: "#EAF3FF", dark: "#112B49", forced: "Canvas", purpose: "state" },
  { name: "service-codecommit", light: "#C45500", dark: "#FF9B55", forced: "LinkText", purpose: "provenance" },
  { name: "service-codepipeline", light: "#8A42C2", dark: "#D69CFF", forced: "LinkText", purpose: "provenance" },
  { name: "service-jira", light: "#0C66E4", dark: "#75AEFF", forced: "LinkText", purpose: "provenance" },
  { name: "service-confluence", light: "#4758D6", dark: "#9EA9FF", forced: "LinkText", purpose: "provenance" },
  { name: "service-clockify", light: "#0087C7", dark: "#64CCF2", forced: "LinkText", purpose: "provenance" }
])

/** Text and non-text contrast invariants for both schemes. */
export const contrastPairSource = defineContrastPairs([
  { name: "primary text", foreground: "text-1", background: "canvas", minimum: 7 },
  { name: "secondary text", foreground: "text-2", background: "canvas", minimum: 4.5 },
  { name: "tertiary text", foreground: "text-3", background: "canvas", minimum: 4.5 },
  { name: "principal action", foreground: "action-foreground", background: "action-background", minimum: 7 },
  { name: "success state", foreground: "success-ink", background: "success-tint", minimum: 4.5 },
  { name: "blocked state", foreground: "blocked-ink", background: "blocked-tint", minimum: 4.5 },
  { name: "held state", foreground: "held-ink", background: "held-tint", minimum: 4.5 },
  { name: "deploying state", foreground: "deploying-ink", background: "deploying-tint", minimum: 4.5 },
  { name: "focus on canvas", foreground: "focus", background: "canvas", minimum: 3 }
])
