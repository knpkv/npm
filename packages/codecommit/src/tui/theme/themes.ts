import { defaultTheme, type Theme } from "./default.js"
import { isThemeJson, jsonToTheme } from "./Resolver.js"
import { themeRegistry } from "./ThemeRegistry.js"

export const themes: Record<string, Theme> = {}

for (const [name, json] of Object.entries(themeRegistry)) {
  if (isThemeJson(json)) {
    themes[`${name}-dark`] = jsonToTheme(json, "dark")
    themes[`${name}-light`] = jsonToTheme(json, "light")
  }
}

themes.dark = themes["dracula-dark"] ?? Object.values(themes)[0] ?? defaultTheme
themes.light = themes["aura-light"] ?? Object.values(themes)[1] ?? defaultTheme
