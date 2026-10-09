import type { ColorTokenSource, ContrastPairSource } from "./model.js"

const defineColors = <const Tokens extends ReadonlyArray<ColorTokenSource>>(tokens: Tokens): Tokens => tokens
const defineContrastPairs = <const Pairs extends ReadonlyArray<ContrastPairSource>>(pairs: Pairs): Pairs => pairs

/**
 * Private palette values in OKLCH (neutrals use hue `none`). Components consume only the generated
 * semantic variables. Each value displays as exactly the sRGB colour it replaced (test/tokens/oklch-parity).
 */
export const colorTokenSource = defineColors([
  {
    name: "canvas",
    light: "oklch(97.37% 0.0026 286.35)",
    dark: "oklch(17.79% 0.0064 271.04)",
    forced: "Canvas",
    purpose: "content"
  },
  {
    name: "surface-1",
    light: "oklch(100% 0 none)",
    dark: "oklch(20.97% 0.008 274.53)",
    forced: "Canvas",
    purpose: "content"
  },
  {
    name: "surface-2",
    light: "oklch(95.82% 0.0041 271.37)",
    dark: "oklch(24.36% 0.01 268.27)",
    forced: "Canvas",
    purpose: "content"
  },
  {
    name: "surface-3",
    light: "oklch(93.44% 0.0055 274.96)",
    dark: "oklch(28.59% 0.0131 272.91)",
    forced: "Canvas",
    purpose: "content"
  },
  {
    name: "text-1",
    light: "oklch(20.92% 0.0061 271.12)",
    dark: "oklch(96.77% 0.0027 286.35)",
    forced: "CanvasText",
    purpose: "content"
  },
  {
    name: "text-2",
    light: "oklch(49.01% 0.013 274.7)",
    dark: "oklch(78.66% 0.0115 274.85)",
    forced: "CanvasText",
    purpose: "content"
  },
  {
    name: "text-3",
    light: "oklch(54.91% 0.0144 271.15)",
    dark: "oklch(67.38% 0.0151 272.6)",
    forced: "CanvasText",
    purpose: "content"
  },
  {
    name: "border-1",
    light: "oklch(89.47% 0.0085 271.32)",
    dark: "oklch(31.84% 0.0145 274.43)",
    forced: "ButtonBorder",
    purpose: "content"
  },
  {
    name: "border-2",
    light: "oklch(79.56% 0.0131 271.25)",
    dark: "oklch(42.9% 0.0186 273.49)",
    forced: "ButtonBorder",
    purpose: "content"
  },
  {
    name: "action-background",
    light: "oklch(20.92% 0.0061 271.12)",
    dark: "oklch(96.77% 0.0027 286.35)",
    forced: "ButtonFace",
    purpose: "content"
  },
  {
    name: "action-foreground",
    light: "oklch(100% 0 none)",
    dark: "oklch(20.92% 0.0061 271.12)",
    forced: "ButtonText",
    purpose: "content"
  },
  {
    name: "focus",
    light: "oklch(57.68% 0.2328 259.8)",
    dark: "oklch(77.5% 0.1149 259.12)",
    forced: "Highlight",
    purpose: "content"
  },
  {
    name: "agent",
    light: "oklch(47.08% 0.1548 297.66)",
    dark: "oklch(75.36% 0.1225 301.6)",
    forced: "LinkText",
    purpose: "content"
  },
  {
    name: "success-ink",
    light: "oklch(49.55% 0.1249 150.69)",
    dark: "oklch(78.4% 0.1445 152.74)",
    forced: "CanvasText",
    purpose: "state"
  },
  {
    name: "success-tint",
    light: "oklch(96.17% 0.0174 153.57)",
    dark: "oklch(28.91% 0.0461 157.59)",
    forced: "Canvas",
    purpose: "state"
  },
  {
    name: "blocked-ink",
    light: "oklch(50.03% 0.1821 29.51)",
    dark: "oklch(76.13% 0.142 25.57)",
    forced: "CanvasText",
    purpose: "state"
  },
  {
    name: "blocked-tint",
    light: "oklch(95.6% 0.0187 25.6)",
    dark: "oklch(26.13% 0.0525 23.12)",
    forced: "Canvas",
    purpose: "state"
  },
  {
    name: "held-ink",
    light: "oklch(46.86% 0.0987 75.3)",
    dark: "oklch(84.49% 0.1205 85.16)",
    forced: "CanvasText",
    purpose: "state"
  },
  {
    name: "held-tint",
    light: "oklch(97.14% 0.0344 88.77)",
    dark: "oklch(28.06% 0.0417 82.9)",
    forced: "Canvas",
    purpose: "state"
  },
  {
    name: "deploying-ink",
    light: "oklch(49.3% 0.1652 256.17)",
    dark: "oklch(74.53% 0.1323 257.25)",
    forced: "CanvasText",
    purpose: "state"
  },
  {
    name: "deploying-tint",
    light: "oklch(96.09% 0.0188 255.53)",
    dark: "oklch(28.58% 0.0639 253.7)",
    forced: "Canvas",
    purpose: "state"
  },
  {
    name: "service-codecommit",
    light: "oklch(58.25% 0.1609 47.1)",
    dark: "oklch(78.01% 0.1467 53.69)",
    forced: "LinkText",
    purpose: "provenance"
  },
  {
    name: "service-codepipeline",
    light: "oklch(53.23% 0.1942 306.77)",
    dark: "oklch(78.38% 0.1486 310.24)",
    forced: "LinkText",
    purpose: "provenance"
  },
  {
    name: "service-jira",
    light: "oklch(54.19% 0.2065 259.4)",
    dark: "oklch(74.53% 0.1323 257.25)",
    forced: "LinkText",
    purpose: "provenance"
  },
  {
    name: "service-confluence",
    light: "oklch(52.21% 0.1926 272.06)",
    dark: "oklch(76.01% 0.1239 277.45)",
    forced: "LinkText",
    purpose: "provenance"
  },
  {
    name: "service-clockify",
    light: "oklch(59.46% 0.1365 240.15)",
    dark: "oklch(79.78% 0.11 224.74)",
    forced: "LinkText",
    purpose: "provenance"
  },
  // Chart series in assignment order: neighbours differ in hue and lightness, and orange sits sixth
  // so a small chart does not read as provider provenance. Charts always ship a labelled key and a
  // table equivalent, so colour is never the only carrier; forced colours collapse to CanvasText.
  // Every series keeps 3:1 against the canvas and the first surface in both schemes (see below).
  {
    name: "series-1",
    light: "oklch(57.53% 0.1626 255.53)",
    dark: "oklch(62.21% 0.1612 255.05)",
    forced: "CanvasText",
    purpose: "series"
  },
  {
    name: "series-2",
    light: "oklch(52.85% 0.1798 142.5)",
    dark: "oklch(61.45% 0.1797 143)",
    forced: "CanvasText",
    purpose: "series"
  },
  {
    name: "series-3",
    light: "oklch(59% 0.1537 358.49)",
    dark: "oklch(62.24% 0.1712 0.84)",
    forced: "CanvasText",
    purpose: "series"
  },
  {
    name: "series-4",
    light: "oklch(56.27% 0.118 76.33)",
    dark: "oklch(66.99% 0.1425 73.23)",
    forced: "CanvasText",
    purpose: "series"
  },
  {
    name: "series-5",
    light: "oklch(53.81% 0.1139 161.78)",
    dark: "oklch(62.12% 0.1283 163.11)",
    forced: "CanvasText",
    purpose: "series"
  },
  {
    name: "series-6",
    light: "oklch(57.67% 0.1603 40.99)",
    dark: "oklch(62.21% 0.1726 40.11)",
    forced: "CanvasText",
    purpose: "series"
  },
  {
    name: "series-7",
    light: "oklch(43.31% 0.1671 283.62)",
    dark: "oklch(66.96% 0.1452 286.83)",
    forced: "CanvasText",
    purpose: "series"
  },
  {
    name: "series-8",
    light: "oklch(58.03% 0.1863 25.45)",
    dark: "oklch(66.93% 0.1586 22.31)",
    forced: "CanvasText",
    purpose: "series"
  },
  {
    name: "series-other",
    light: "oklch(56.55% 0.0062 95.16)",
    dark: "oklch(58.93% 0.0061 95.15)",
    forced: "CanvasText",
    purpose: "series"
  }
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
  // StateLabel draws its word straight on the host surface (no tint), so every ink must read on every surface.
  { name: "success word on canvas", foreground: "success-ink", background: "canvas", minimum: 4.5 },
  { name: "success word on surface-1", foreground: "success-ink", background: "surface-1", minimum: 4.5 },
  { name: "success word on surface-2", foreground: "success-ink", background: "surface-2", minimum: 4.5 },
  { name: "success word on surface-3", foreground: "success-ink", background: "surface-3", minimum: 4.5 },
  { name: "blocked word on canvas", foreground: "blocked-ink", background: "canvas", minimum: 4.5 },
  { name: "blocked word on surface-1", foreground: "blocked-ink", background: "surface-1", minimum: 4.5 },
  { name: "blocked word on surface-2", foreground: "blocked-ink", background: "surface-2", minimum: 4.5 },
  { name: "blocked word on surface-3", foreground: "blocked-ink", background: "surface-3", minimum: 4.5 },
  { name: "held word on canvas", foreground: "held-ink", background: "canvas", minimum: 4.5 },
  { name: "held word on surface-1", foreground: "held-ink", background: "surface-1", minimum: 4.5 },
  { name: "held word on surface-2", foreground: "held-ink", background: "surface-2", minimum: 4.5 },
  { name: "held word on surface-3", foreground: "held-ink", background: "surface-3", minimum: 4.5 },
  { name: "deploying word on canvas", foreground: "deploying-ink", background: "canvas", minimum: 4.5 },
  { name: "deploying word on surface-1", foreground: "deploying-ink", background: "surface-1", minimum: 4.5 },
  { name: "deploying word on surface-2", foreground: "deploying-ink", background: "surface-2", minimum: 4.5 },
  { name: "deploying word on surface-3", foreground: "deploying-ink", background: "surface-3", minimum: 4.5 },
  { name: "focus on canvas", foreground: "focus", background: "canvas", minimum: 3 },
  { name: "series 1 on canvas", foreground: "series-1", background: "canvas", minimum: 3 },
  { name: "series 1 on surface-1", foreground: "series-1", background: "surface-1", minimum: 3 },
  { name: "series 2 on canvas", foreground: "series-2", background: "canvas", minimum: 3 },
  { name: "series 2 on surface-1", foreground: "series-2", background: "surface-1", minimum: 3 },
  { name: "series 3 on canvas", foreground: "series-3", background: "canvas", minimum: 3 },
  { name: "series 3 on surface-1", foreground: "series-3", background: "surface-1", minimum: 3 },
  { name: "series 4 on canvas", foreground: "series-4", background: "canvas", minimum: 3 },
  { name: "series 4 on surface-1", foreground: "series-4", background: "surface-1", minimum: 3 },
  { name: "series 5 on canvas", foreground: "series-5", background: "canvas", minimum: 3 },
  { name: "series 5 on surface-1", foreground: "series-5", background: "surface-1", minimum: 3 },
  { name: "series 6 on canvas", foreground: "series-6", background: "canvas", minimum: 3 },
  { name: "series 6 on surface-1", foreground: "series-6", background: "surface-1", minimum: 3 },
  { name: "series 7 on canvas", foreground: "series-7", background: "canvas", minimum: 3 },
  { name: "series 7 on surface-1", foreground: "series-7", background: "surface-1", minimum: 3 },
  { name: "series 8 on canvas", foreground: "series-8", background: "canvas", minimum: 3 },
  { name: "series 8 on surface-1", foreground: "series-8", background: "surface-1", minimum: 3 },
  { name: "series other on canvas", foreground: "series-other", background: "canvas", minimum: 3 },
  { name: "series other on surface-1", foreground: "series-other", background: "surface-1", minimum: 3 },
  { name: "limit near mark on track", foreground: "text-1", background: "surface-3", minimum: 3 },
  { name: "limit near halo on fill", foreground: "surface-1", background: "text-2", minimum: 3 },
  { name: "limit near halo on near fill", foreground: "surface-1", background: "held-ink", minimum: 3 },
  { name: "limit near halo on full fill", foreground: "surface-1", background: "blocked-ink", minimum: 3 }
])
