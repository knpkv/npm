import { controlCenterDarkTheme, controlCenterLightTheme, type Theme } from "./default.js"
import { isThemeJson, jsonToTheme } from "./Resolver.js"
import { themeRegistry } from "./ThemeRegistry.js"

export const themes: Record<string, Theme> = {}

for (const [name, json] of Object.entries(themeRegistry)) {
  if (isThemeJson(json)) {
    themes[`${name}-dark`] = jsonToTheme(json, "dark")
    themes[`${name}-light`] = jsonToTheme(json, "light")
  }
}

themes["control-center-dark"] = controlCenterDarkTheme
themes["control-center-light"] = controlCenterLightTheme
themes.dark = controlCenterDarkTheme
themes.light = controlCenterLightTheme
