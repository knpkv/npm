import { describe, expect, it } from "vitest"

describe("initial public entries", () => {
  it("exports foundations and browser-safe semantic token names from the root", async () => {
    const Rly = await import("../../src/index.js")

    expect(Object.keys(Rly)).toEqual([
      "GlobalStyles",
      "Icon",
      "RLY_ICON_DEFAULT_VARIANTS",
      "RLY_ICON_NAMES",
      "RLY_ICON_VARIANTS",
      "LinkProvider",
      "PortalProvider",
      "RLY_THEME_NAMES",
      "ThemeProvider",
      "RLY_COLOR_TOKEN_NAMES",
      "RLY_MOTION_TOKEN_NAMES",
      "RLY_RADIUS_TOKEN_NAMES",
      "RLY_SPACE_TOKEN_NAMES",
      "RLY_TYPE_TOKEN_NAMES"
    ])
  })

  it("keeps the universal token entry free of React foundations", async () => {
    const Tokens = await import("../../src/tokens/index.js")

    expect(Object.keys(Tokens)).toEqual([
      "RLY_COLOR_TOKEN_NAMES",
      "RLY_MOTION_TOKEN_NAMES",
      "RLY_RADIUS_TOKEN_NAMES",
      "RLY_SPACE_TOKEN_NAMES",
      "RLY_TYPE_TOKEN_NAMES"
    ])
  })
})
