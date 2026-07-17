import { describe, expect, it, vi } from "vitest"

vi.setConfig({ testTimeout: 10_000 })

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
      "AgentContextButton",
      "AgentDrawer",
      "AgentJob",
      "AgentProposal",
      "AgentThread",
      "CollaboratorGroup",
      "RLY_COLLABORATOR_GROUP_DEFAULT_VARIANTS",
      "RLY_COLLABORATOR_GROUP_VARIANTS",
      "EntityShell",
      "EntityTable",
      "EvidenceStamp",
      "FreshnessStamp",
      "RLY_FRESHNESS_STAMP_DEFAULT_VARIANTS",
      "RLY_FRESHNESS_STAMP_VARIANTS",
      "GovernedActionReview",
      "PeopleStrip",
      "RLY_PEOPLE_STRIP_DEFAULT_VARIANTS",
      "RLY_PEOPLE_STRIP_VARIANTS",
      "Person",
      "RLY_PERSON_DEFAULT_VARIANTS",
      "RLY_PERSON_VARIANTS",
      "RelationshipChain",
      "RLY_RELATIONSHIP_DIRECTION_PRESENTATION",
      "RLY_RELATIONSHIP_LIFECYCLE_PRESENTATION",
      "RelationshipTable",
      "ReleasePreview",
      "ReleaseRelay",
      "RLY_RELEASE_RELAY_DEFAULT_VARIANTS",
      "RLY_RELEASE_RELAY_SYMBOLS",
      "RLY_RELEASE_RELAY_VARIANTS",
      "ReleaseRow",
      "RLY_SERVICE_MARK_DEFAULT_VARIANTS",
      "RLY_SERVICE_MARK_VARIANTS",
      "ServiceMark",
      "RLY_STAGE_RAIL_DEFAULT_VARIANTS",
      "RLY_STAGE_RAIL_VARIANTS",
      "StageRail",
      "TimelineRow",
      "RLY_VERDICT_VARIANTS",
      "Verdict",
      "WorksetCard",
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

  it("keeps the experimental renderer isolated behind the diff entry", async () => {
    const Diff = await import("../../src/diff/index.js")

    expect(Object.keys(Diff)).toEqual([
      "DiffCodeView",
      "DiffFileTree",
      "DiffFinding",
      "DiffHeader",
      "DiffWorkbench",
      "RLY_DIFF_THEMES",
      "createDiffWorkerFactory",
      "DiffWorkerProvider",
      "normalizeDiffWorkerPoolSize"
    ])
  })
})
