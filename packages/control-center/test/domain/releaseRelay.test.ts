import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { ReleaseId } from "../../src/domain/identifiers.js"
import {
  deriveReleaseRelay,
  RELEASE_RELAY_ALGORITHM,
  RELEASE_RELAY_V1_ADJECTIVES,
  RELEASE_RELAY_V1_NOUNS,
  ReleaseRelayProjection
} from "../../src/domain/releaseRelay.js"

const decodeReleaseId = Schema.decodeUnknownSync(ReleaseId)

const goldenVectors = [
  {
    projection: { algorithm: "relay/v1", codename: "Lunar Harbor", symbolIndices: [13, 8, 10] },
    releaseId: decodeReleaseId("01890f00-0000-7000-8000-000000000001")
  },
  {
    projection: { algorithm: "relay/v1", codename: "Quiet Spark", symbolIndices: [0, 4, 14] },
    releaseId: decodeReleaseId("0190f3dd-7c20-7abc-8def-0123456789ab")
  },
  {
    projection: { algorithm: "relay/v1", codename: "Copper Comet", symbolIndices: [10, 7, 2] },
    releaseId: decodeReleaseId("019b2d89-4f80-7001-b123-fedcba987654")
  }
]

describe("Release Relay domain projection", () => {
  it("pins the frozen relay/v1 catalog order", () => {
    expect(RELEASE_RELAY_ALGORITHM).toBe("relay/v1")
    expect(RELEASE_RELAY_V1_ADJECTIVES).toEqual([
      "Amber",
      "Azure",
      "Copper",
      "Ember",
      "Golden",
      "Lunar",
      "Moss",
      "Nova",
      "Quiet",
      "Silver",
      "Solar",
      "Tidal",
      "Velvet",
      "Verdant",
      "Wild",
      "Winter"
    ])
    expect(RELEASE_RELAY_V1_NOUNS).toEqual([
      "Anchor",
      "Beacon",
      "Bridge",
      "Comet",
      "Finch",
      "Fork",
      "Gate",
      "Grove",
      "Harbor",
      "Orbit",
      "Pulse",
      "Reef",
      "Relay",
      "Spark",
      "Wave",
      "Willow"
    ])
    expect(Object.isFrozen(RELEASE_RELAY_V1_ADJECTIVES)).toBe(true)
    expect(Object.isFrozen(RELEASE_RELAY_V1_NOUNS)).toBe(true)
  })

  it("pins independently calculated golden relay/v1 projections", () => {
    for (const vector of goldenVectors) {
      expect(deriveReleaseRelay(vector.releaseId)).toEqual(vector.projection)
    }
  })

  it("is deterministic and always derives exactly three distinct bounded symbols", () => {
    const releaseIds = Array.from(
      { length: 256 },
      (_, sequence) => decodeReleaseId(`0190f3dd-7c20-7abc-8def-${sequence.toString(16).padStart(12, "0")}`)
    )

    for (const releaseId of releaseIds) {
      const firstProjection = deriveReleaseRelay(releaseId)
      const secondProjection = deriveReleaseRelay(releaseId)
      expect(firstProjection).toEqual(secondProjection)
      expect(firstProjection.symbolIndices).toHaveLength(3)
      expect(new Set(firstProjection.symbolIndices).size).toBe(3)
      for (const symbolIndex of firstProjection.symbolIndices) {
        expect(Number.isInteger(symbolIndex)).toBe(true)
        expect(symbolIndex).toBeGreaterThanOrEqual(0)
        expect(symbolIndex).toBeLessThanOrEqual(15)
      }
    }
  })

  it.prop(
    "keeps every generated release ID stable, distinct, and bounded",
    [Schema.toArbitrary(ReleaseId)],
    ([releaseId]) => {
      const projection = deriveReleaseRelay(releaseId)
      return (
        projection.symbolIndices.length === 3 &&
        new Set(projection.symbolIndices).size === 3 &&
        projection.symbolIndices.every((symbolIndex) => symbolIndex >= 0 && symbolIndex <= 15) &&
        deriveReleaseRelay(releaseId).codename === projection.codename
      )
    }
  )

  it("rejects unknown algorithms and malformed persisted projections", () => {
    const malformedProjections = [
      { algorithm: "relay/v2", codename: "Lunar Harbor", symbolIndices: [13, 8, 10] },
      { algorithm: "relay/v1", codename: "Unknown Harbor", symbolIndices: [13, 8, 10] },
      { algorithm: "relay/v1", codename: "Lunar Harbor", symbolIndices: [13, 8] },
      { algorithm: "relay/v1", codename: "Lunar Harbor", symbolIndices: [13, 8, 16] },
      { algorithm: "relay/v1", codename: "Lunar Harbor", symbolIndices: [13, 8, 8] }
    ]

    for (const projection of malformedProjections) {
      expect(Result.isFailure(Schema.decodeUnknownResult(ReleaseRelayProjection)(projection))).toBe(true)
    }
  })
})
