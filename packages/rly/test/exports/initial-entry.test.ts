import { describe, expect, it } from "vitest"

describe("public entries", () => {
  it("exports foundations, primitives, and browser-safe semantic token names from the root", async () => {
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
      "Avatar",
      "RLY_AVATAR_DEFAULT_VARIANTS",
      "RLY_AVATAR_VARIANTS",
      "Button",
      "RLY_BUTTON_DEFAULT_VARIANTS",
      "RLY_BUTTON_VARIANTS",
      "Divider",
      "RLY_DIVIDER_DEFAULT_VARIANTS",
      "RLY_DIVIDER_VARIANTS",
      "IconButton",
      "RLY_ICON_BUTTON_DEFAULT_VARIANTS",
      "RLY_ICON_BUTTON_VARIANTS",
      "RLY_SKELETON_DEFAULT_VARIANTS",
      "RLY_SKELETON_VARIANTS",
      "Skeleton",
      "RLY_STATE_LABEL_DEFAULT_VARIANTS",
      "RLY_STATE_LABEL_VARIANTS",
      "StateLabel",
      "RLY_STATE_PANEL_DEFAULT_VARIANTS",
      "RLY_STATE_PANEL_VARIANTS",
      "StatePanel",
      "RLY_SURFACE_DEFAULT_VARIANTS",
      "RLY_SURFACE_VARIANTS",
      "Surface",
      "RLY_TEXT_DEFAULT_VARIANTS",
      "RLY_TEXT_VARIANTS",
      "Text",
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
