import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { evaluateReleaseFreshnessAt, Freshness, PluginHealth } from "../../src/domain/freshness.js"
import { PluginConnectionId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"

const connectionId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000091")
const lastRead = "2026-07-14T12:00:00.000Z"
const failedAt = "2026-07-14T12:01:00.000Z"

const current = Schema.decodeUnknownSync(Freshness)({
  _tag: "current",
  pluginHealth: { _tag: "healthy", checkedAt: lastRead },
  provenance: {
    _tag: "provider",
    sourceRevision: {
      pluginConnectionId: connectionId,
      providerId: "jira",
      vendorImmutableId: "fixture-release",
      revision: "1",
      sourceUrl: null,
      firstObservedAt: lastRead,
      lastObservedAt: lastRead,
      synchronizedAt: lastRead,
      normalizationSchemaVersion: 1
    }
  },
  sourceObservedAt: lastRead,
  synchronizedAt: lastRead,
  staleAfterSeconds: 86_400
})

describe("release source freshness", () => {
  it.effect("a rejected credential immediately hides Current while preserving the last good read", () =>
    Effect.gen(function*() {
      const health = Schema.decodeUnknownSync(PluginHealth)({
        _tag: "unavailable",
        checkedAt: failedAt,
        failureClass: "authentication",
        retryAt: null,
        safeMessage: "Fixture credentials were rejected."
      })
      const projected = yield* evaluateReleaseFreshnessAt(
        current,
        Schema.decodeUnknownSync(UtcTimestamp)(failedAt),
        [{
          pluginConnectionId: connectionId,
          health,
          unavailableSince: Schema.decodeUnknownSync(UtcTimestamp)(failedAt)
        }]
      )

      expect(projected._tag).toBe("source-unavailable")
      if (projected._tag !== "source-unavailable") return
      expect(Schema.encodeSync(Schema.NullOr(UtcTimestamp))(projected.unavailableSince)).toBe(failedAt)
      expect(Schema.encodeSync(Schema.NullOr(UtcTimestamp))(projected.lastReadAt)).toBe(lastRead)
      expect(projected.failedSources[0]?.health.failureClass).toBe("authentication")
      expect(current._tag).toBe("current")
    }))

  it.effect("healthy sources remain current until the configured age boundary", () =>
    Effect.gen(function*() {
      const healthy = [{
        pluginConnectionId: connectionId,
        health: current.pluginHealth,
        unavailableSince: null
      }]
      expect(
        (yield* evaluateReleaseFreshnessAt(current, Schema.decodeUnknownSync(UtcTimestamp)(failedAt), healthy))._tag
      )
        .toBe("current")
      const aged = yield* evaluateReleaseFreshnessAt(
        current,
        Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T12:00:00.000Z"),
        healthy
      )
      expect(aged._tag).toBe("stale")
      expect(aged.synchronizedAt).toEqual(current.synchronizedAt)
    }))

  it.effect("a failing secondary source prevents a current label even when the primary is healthy", () =>
    Effect.gen(function*() {
      const secondary = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000092")
      const checkedAt = Schema.decodeUnknownSync(UtcTimestamp)(failedAt)
      const health = Schema.decodeUnknownSync(PluginHealth)({
        _tag: "degraded",
        checkedAt: failedAt,
        failureClass: "timeout",
        retryAt: null,
        safeMessage: "Fixture source timed out."
      })
      const projected = yield* evaluateReleaseFreshnessAt(current, checkedAt, [
        { pluginConnectionId: connectionId, health: current.pluginHealth, unavailableSince: null },
        { pluginConnectionId: secondary, health, unavailableSince: checkedAt }
      ])
      expect(projected._tag).toBe("source-unavailable")
      if (projected._tag === "source-unavailable") {
        expect(projected.failedSources.map(({ pluginConnectionId }) => pluginConnectionId)).toEqual([secondary])
      }
    }))
})
