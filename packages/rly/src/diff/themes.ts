import { registerCustomCSSVariableTheme } from "@pierre/diffs"

/** Stable custom theme identifiers registered for the isolated diff renderer. */
export const RLY_DIFF_THEMES: { readonly dark: "rly-dark"; readonly light: "rly-light" } = {
  dark: "rly-dark",
  light: "rly-light"
}

const VARIABLE_DEFAULTS: Record<string, string> = {
  "ansi-black": "var(--rly-color-text-1)",
  "ansi-blue": "var(--rly-color-text-1)",
  "ansi-bright-black": "var(--rly-color-text-2)",
  "ansi-bright-blue": "var(--rly-color-text-1)",
  "ansi-bright-cyan": "var(--rly-color-text-1)",
  "ansi-bright-green": "var(--rly-color-text-1)",
  "ansi-bright-magenta": "var(--rly-color-text-1)",
  "ansi-bright-red": "var(--rly-color-text-1)",
  "ansi-bright-white": "var(--rly-color-text-1)",
  "ansi-bright-yellow": "var(--rly-color-text-1)",
  "ansi-cyan": "var(--rly-color-text-1)",
  "ansi-green": "var(--rly-color-text-1)",
  "ansi-magenta": "var(--rly-color-text-1)",
  "ansi-red": "var(--rly-color-text-1)",
  "ansi-white": "var(--rly-color-text-2)",
  "ansi-yellow": "var(--rly-color-text-1)",
  background: "var(--rly-color-surface-1)",
  foreground: "var(--rly-color-text-1)",
  "token-changed": "var(--rly-color-text-1)",
  "token-comment": "var(--rly-color-text-3)",
  "token-constant": "var(--rly-color-text-1)",
  "token-deleted": "var(--rly-color-text-1)",
  "token-function": "var(--rly-color-text-1)",
  "token-inserted": "var(--rly-color-text-1)",
  "token-keyword": "var(--rly-color-text-1)",
  "token-link": "var(--rly-color-text-1)",
  "token-parameter": "var(--rly-color-text-1)",
  "token-punctuation": "var(--rly-color-text-1)",
  "token-string": "var(--rly-color-text-1)",
  "token-string-expression": "var(--rly-color-text-1)"
}

let themesRegistered = false

export const ensureRlyDiffThemes = (): void => {
  if (themesRegistered) return
  registerCustomCSSVariableTheme(RLY_DIFF_THEMES.light, VARIABLE_DEFAULTS)
  registerCustomCSSVariableTheme(RLY_DIFF_THEMES.dark, VARIABLE_DEFAULTS)
  themesRegistered = true
}
