import { describe, expect, it } from "vitest"
import { RLY_COLLABORATOR_GROUP_VARIANTS } from "../../src/patterns/CollaboratorGroup.js"
import { RLY_FRESHNESS_STAMP_VARIANTS } from "../../src/patterns/FreshnessStamp.js"
import { RLY_PEOPLE_STRIP_VARIANTS } from "../../src/patterns/PeopleStrip.js"
import { RLY_PERSON_VARIANTS } from "../../src/patterns/Person.js"
import { RLY_RELEASE_RELAY_VARIANTS } from "../../src/patterns/ReleaseRelay.js"
import { RLY_SERVICE_MARK_VARIANTS } from "../../src/patterns/ServiceMark.js"
import { RLY_STAGE_RAIL_VARIANTS } from "../../src/patterns/StageRail.js"
import { RLY_VERDICT_VARIANTS } from "../../src/patterns/Verdict.js"
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

interface VariantMetadata {
  readonly className: string
  readonly purpose: string
  readonly tokens: ReadonlyArray<string>
}

type VariantCatalog = Readonly<Record<string, Readonly<Record<string, VariantMetadata>>>>

const catalogs: ReadonlyArray<VariantCatalog> = [
  RLY_COLLABORATOR_GROUP_VARIANTS,
  RLY_FRESHNESS_STAMP_VARIANTS,
  RLY_PEOPLE_STRIP_VARIANTS,
  RLY_PERSON_VARIANTS,
  RLY_RELEASE_RELAY_VARIANTS,
  RLY_SERVICE_MARK_VARIANTS,
  RLY_STAGE_RAIL_VARIANTS,
  RLY_VERDICT_VARIANTS
]

describe("pattern metadata", () => {
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
