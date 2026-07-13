import { describe, expect, it } from "vitest"
import { RLY_AVATAR_VARIANTS } from "../../src/primitives/Avatar.js"
import { RLY_BUTTON_VARIANTS } from "../../src/primitives/Button.js"
import { RLY_DIVIDER_VARIANTS } from "../../src/primitives/Divider.js"
import { RLY_FIELD_VARIANTS } from "../../src/primitives/Field.js"
import { RLY_ICON_BUTTON_VARIANTS } from "../../src/primitives/IconButton.js"
import { RLY_SELECT_VARIANTS } from "../../src/primitives/Select.js"
import { RLY_SKELETON_VARIANTS } from "../../src/primitives/Skeleton.js"
import { RLY_STATE_LABEL_VARIANTS } from "../../src/primitives/StateLabel.js"
import { RLY_STATE_PANEL_VARIANTS } from "../../src/primitives/StatePanel.js"
import { RLY_SURFACE_VARIANTS } from "../../src/primitives/Surface.js"
import { RLY_TABS_VARIANTS } from "../../src/primitives/Tabs.js"
import { RLY_TEXT_VARIANTS } from "../../src/primitives/Text.js"
import {
  RLY_COLOR_TOKEN_NAMES,
  RLY_MOTION_TOKEN_NAMES,
  RLY_RADIUS_TOKEN_NAMES,
  RLY_SPACE_TOKEN_NAMES,
  RLY_TYPE_TOKEN_NAMES
} from "../../src/tokens/semantic-tokens.js"

const semanticTokens = new Set<string>([
  ...RLY_COLOR_TOKEN_NAMES.map((name) => `color-${name}`),
  ...RLY_MOTION_TOKEN_NAMES.map((name) => `motion-${name}`),
  ...RLY_RADIUS_TOKEN_NAMES.map((name) => `radius-${name}`),
  ...RLY_SPACE_TOKEN_NAMES.map((name) => `space-${name}`),
  ...RLY_TYPE_TOKEN_NAMES.map((name) => `type-${name}`)
])

const catalogs: ReadonlyArray<
  Readonly<
    Record<
      string,
      Readonly<
        Record<string, {
          readonly className: string
          readonly purpose: string
          readonly tokens: ReadonlyArray<string>
        }>
      >
    >
  >
> = [
  RLY_AVATAR_VARIANTS,
  RLY_BUTTON_VARIANTS,
  RLY_DIVIDER_VARIANTS,
  RLY_FIELD_VARIANTS,
  RLY_ICON_BUTTON_VARIANTS,
  RLY_SELECT_VARIANTS,
  RLY_SKELETON_VARIANTS,
  RLY_STATE_LABEL_VARIANTS,
  RLY_STATE_PANEL_VARIANTS,
  RLY_SURFACE_VARIANTS,
  RLY_TABS_VARIANTS,
  RLY_TEXT_VARIANTS
]

describe("primitive metadata", () => {
  it("references only published semantic tokens and generated classes", () => {
    for (const catalog of catalogs) {
      for (const axis of Object.values(catalog)) {
        for (const metadata of Object.values(axis)) {
          expect(metadata.className).not.toHaveLength(0)
          expect(metadata.purpose.trim()).not.toHaveLength(0)
          for (const token of metadata.tokens) expect(semanticTokens).toContain(token)
        }
      }
    }
  })
})
