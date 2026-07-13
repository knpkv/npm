import { describe, expect, it } from "vitest"

describe("public entries", () => {
  it("exports foundations, patterns, primitives, and browser-safe semantic token names from the root", async () => {
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
      "CollaboratorGroup",
      "RLY_COLLABORATOR_GROUP_DEFAULT_VARIANTS",
      "RLY_COLLABORATOR_GROUP_VARIANTS",
      "EvidenceStamp",
      "FreshnessStamp",
      "RLY_FRESHNESS_STAMP_DEFAULT_VARIANTS",
      "RLY_FRESHNESS_STAMP_VARIANTS",
      "PeopleStrip",
      "RLY_PEOPLE_STRIP_DEFAULT_VARIANTS",
      "RLY_PEOPLE_STRIP_VARIANTS",
      "Person",
      "RLY_PERSON_DEFAULT_VARIANTS",
      "RLY_PERSON_VARIANTS",
      "RLY_SERVICE_MARK_DEFAULT_VARIANTS",
      "RLY_SERVICE_MARK_VARIANTS",
      "ServiceMark",
      "Avatar",
      "RLY_AVATAR_DEFAULT_VARIANTS",
      "RLY_AVATAR_VARIANTS",
      "Button",
      "RLY_BUTTON_DEFAULT_VARIANTS",
      "RLY_BUTTON_VARIANTS",
      "Dialog",
      "RLY_DIALOG_DEFAULT_VARIANTS",
      "RLY_DIALOG_VARIANTS",
      "Divider",
      "RLY_DIVIDER_DEFAULT_VARIANTS",
      "RLY_DIVIDER_VARIANTS",
      "Field",
      "RLY_FIELD_DEFAULT_VARIANTS",
      "RLY_FIELD_VARIANTS",
      "IconButton",
      "RLY_ICON_BUTTON_DEFAULT_VARIANTS",
      "RLY_ICON_BUTTON_VARIANTS",
      "RLY_SELECT_DEFAULT_VARIANTS",
      "RLY_SELECT_VARIANTS",
      "Select",
      "RLY_SHEET_DEFAULT_VARIANTS",
      "RLY_SHEET_VARIANTS",
      "Sheet",
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
      "RLY_TABS_DEFAULT_VARIANTS",
      "RLY_TABS_VARIANTS",
      "Tabs",
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
