import { parseColor, RGBA } from "@opentui/core"
import type { Theme } from "./default.js"

// --- TUI Schema ---

type HexColor = `#${string}`
type RefName = string
type Variant = {
  dark: HexColor | RefName
  light: HexColor | RefName
}
type ColorValue = HexColor | RefName | Variant

export interface TuiThemeJson {
  defs?: Record<string, HexColor | RefName>
  theme: Record<string, ColorValue>
}

// --- Resolver Logic ---

function rgbaToHex(rgba: RGBA): string {
  const r = Math.round(rgba.r * 255).toString(16).padStart(2, "0")
  const g = Math.round(rgba.g * 255).toString(16).padStart(2, "0")
  const b = Math.round(rgba.b * 255).toString(16).padStart(2, "0")
  return `#${r}${g}${b}`
}

function resolveTuiTheme(json: TuiThemeJson, mode: "dark" | "light"): Theme {
  const defs = json.defs ?? {}

  function resolveColor(c: ColorValue): RGBA {
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return RGBA.fromInts(0, 0, 0, 0)
      if (c.startsWith("#")) return parseColor(c)
      if (defs[c] != null) return resolveColor(defs[c] as ColorValue)
      if (json.theme[c] !== undefined) return resolveColor(json.theme[c] as ColorValue)
      return RGBA.fromInts(128, 128, 128, 255)
    }
    return resolveColor(c[mode])
  }

  const t = json.theme
  const fallbackBg = "#1e1e1e"
  const fallbackText = "#d4d4d4"
  const fallbackGray = "#808080"

  const primary = resolveColor(t.primary ?? t.syntaxFunction ?? fallbackGray)
  const background = resolveColor(t.background ?? fallbackBg)
  const backgroundPanel = resolveColor(t.backgroundPanel ?? fallbackBg)
  const backgroundElement = resolveColor(t.backgroundElement ?? t.backgroundPanel ?? fallbackBg)
  const text = resolveColor(t.text ?? fallbackText)
  const textMuted = resolveColor(t.textMuted ?? fallbackGray)
  const errColor = resolveColor(t.error ?? t.diffRemovedBg ?? "#E53E3E")
  const warnColor = resolveColor(t.warning ?? t.diffChangedBg ?? "#DD6B20")
  const successColor = resolveColor(t.success ?? t.diffAddedBg ?? "#38A169")

  // Use backgroundElement for header to avoid harsh contrast of primary color
  const bgHeader = backgroundElement

  return {
    background: rgbaToHex(background),
    backgroundPanel: rgbaToHex(backgroundPanel),
    backgroundElement: rgbaToHex(backgroundElement),
    backgroundHeader: rgbaToHex(bgHeader),
    backgroundHeaderLoading: rgbaToHex(primary),
    backgroundHeaderError: rgbaToHex(errColor),
    backgroundHeaderWarning: rgbaToHex(warnColor),

    text: rgbaToHex(text),
    textMuted: rgbaToHex(textMuted),
    textAccent: rgbaToHex(primary),
    textError: rgbaToHex(errColor),
    textWarning: rgbaToHex(warnColor),
    textSuccess: rgbaToHex(successColor),

    primary: rgbaToHex(primary),
    error: rgbaToHex(errColor),
    warning: rgbaToHex(warnColor),
    success: rgbaToHex(successColor),

    selectedBackground: rgbaToHex(backgroundElement),
    selectedText: rgbaToHex(text),

    markdownText: rgbaToHex(resolveColor(t.markdownText ?? t.text ?? fallbackText)),
    markdownHeading: rgbaToHex(resolveColor(t.markdownHeading ?? t.primary ?? fallbackGray)),
    markdownLink: rgbaToHex(resolveColor(t.markdownLink ?? t.syntaxString ?? fallbackGray)),
    markdownLinkText: rgbaToHex(resolveColor(t.markdownLinkText ?? t.primary ?? fallbackGray)),
    markdownCode: rgbaToHex(resolveColor(t.markdownCode ?? t.syntaxString ?? fallbackGray)),
    markdownCodeBlock: rgbaToHex(resolveColor(t.markdownCodeBlock ?? t.text ?? fallbackText)),
    markdownBlockQuote: rgbaToHex(resolveColor(t.markdownBlockQuote ?? t.syntaxComment ?? fallbackGray)),
    markdownListItem: rgbaToHex(resolveColor(t.markdownListItem ?? t.syntaxKeyword ?? fallbackGray)),
    markdownEmph: rgbaToHex(resolveColor(t.markdownEmph ?? t.text ?? fallbackText)),
    markdownStrong: rgbaToHex(resolveColor(t.markdownStrong ?? t.text ?? fallbackText)),
    markdownHorizontalRule: rgbaToHex(resolveColor(t.markdownHorizontalRule ?? fallbackGray)),
    markdownImage: rgbaToHex(resolveColor(t.markdownImage ?? t.syntaxString ?? fallbackGray)),
    markdownImageText: rgbaToHex(resolveColor(t.markdownImageText ?? t.primary ?? fallbackGray))
  }
}

export type ThemeJson = TuiThemeJson

export function isThemeJson(json: unknown): json is ThemeJson {
  if (typeof json !== "object" || json === null) return false
  return "theme" in json
}

export function jsonToTheme(json: ThemeJson, mode: "dark" | "light"): Theme {
  return resolveTuiTheme(json, mode)
}
