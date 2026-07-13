import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Freshness } from "../../src/domain/freshness.js"

const PLUGIN_CONNECTION_ID = "01912345-6789-7abc-8def-0123456789ab"

const sourceRevision = {
  firstObservedAt: "2026-07-13T08:00:00.000Z",
  lastObservedAt: "2026-07-13T08:30:00.000Z",
  normalizationSchemaVersion: 1,
  pluginConnectionId: PLUGIN_CONNECTION_ID,
  providerId: "jira",
  revision: "42",
  sourceUrl: "https://example.atlassian.net/browse/RPS-6307",
  synchronizedAt: "2026-07-13T08:30:30.000Z",
  vendorImmutableId: "1006307"
}

const healthy = {
  _tag: "healthy",
  checkedAt: "2026-07-13T08:32:00.000Z"
}

describe("Freshness", () => {
  it.effect("roundtrips current provider data with exact source provenance", () =>
    Effect.gen(function*() {
      const encodedFreshness = {
        _tag: "current",
        pluginHealth: healthy,
        provenance: {
          _tag: "provider",
          sourceRevision
        },
        sourceObservedAt: sourceRevision.lastObservedAt,
        staleAfterSeconds: 900,
        synchronizedAt: "2026-07-13T08:31:00.000Z"
      }

      const freshness = yield* Schema.decodeUnknownEffect(Freshness)(encodedFreshness)
      const encoded = yield* Schema.encodeUnknownEffect(Freshness)(freshness)

      expect(freshness._tag).toBe("current")
      expect(encoded).toEqual(encodedFreshness)
    }))

  it.effect("keeps stale cached data when its plugin is unavailable", () =>
    Effect.gen(function*() {
      const encodedFreshness = {
        _tag: "stale",
        pluginHealth: {
          _tag: "unavailable",
          checkedAt: "2026-07-13T10:00:00.000Z",
          failureClass: "outage",
          retryAt: "2026-07-13T10:05:00.000Z",
          safeMessage: "Provider is temporarily unavailable"
        },
        provenance: {
          _tag: "cache",
          cachedAt: "2026-07-13T08:31:00.000Z",
          sourceRevision
        },
        sourceObservedAt: sourceRevision.lastObservedAt,
        staleAfterSeconds: 900,
        synchronizedAt: "2026-07-13T08:31:30.000Z"
      }

      const freshness = yield* Schema.decodeUnknownEffect(Freshness)(encodedFreshness)
      const encoded = yield* Schema.encodeUnknownEffect(Freshness)(freshness)

      expect(freshness._tag).toBe("stale")
      expect(encoded).toEqual(encodedFreshness)
    }))

  it("treats the exact stale threshold as current and the next millisecond as stale", () => {
    const currentAtBoundary = {
      _tag: "current",
      pluginHealth: { ...healthy, checkedAt: "2026-07-13T08:45:00.000Z" },
      provenance: { _tag: "provider", sourceRevision },
      sourceObservedAt: sourceRevision.lastObservedAt,
      staleAfterSeconds: 900,
      synchronizedAt: "2026-07-13T08:31:00.000Z"
    }
    const staleJustOverBoundary = {
      _tag: "stale",
      pluginHealth: { ...healthy, checkedAt: "2026-07-13T08:45:00.001Z" },
      provenance: {
        _tag: "cache",
        cachedAt: "2026-07-13T08:31:00.000Z",
        sourceRevision
      },
      sourceObservedAt: sourceRevision.lastObservedAt,
      staleAfterSeconds: 900,
      synchronizedAt: "2026-07-13T08:31:30.000Z"
    }

    expect(Result.isSuccess(Schema.decodeUnknownResult(Freshness)(currentAtBoundary))).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(Freshness)(staleJustOverBoundary))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Freshness)({
          ...currentAtBoundary,
          pluginHealth: { ...healthy, checkedAt: "2026-07-13T08:45:00.001Z" }
        })
      )
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Freshness)({
          ...staleJustOverBoundary,
          pluginHealth: { ...healthy, checkedAt: "2026-07-13T08:45:00.000Z" }
        })
      )
    ).toBe(true)
  })

  it("distinguishes a successful missing result from an unavailable source", () => {
    const missing = Schema.decodeUnknownResult(Freshness)({
      _tag: "missing",
      pluginHealth: healthy,
      provenance: {
        _tag: "none",
        pluginConnectionId: PLUGIN_CONNECTION_ID
      },
      sourceObservedAt: null,
      staleAfterSeconds: 900,
      synchronizedAt: "2026-07-13T08:31:00.000Z"
    })
    const unavailable = Schema.decodeUnknownResult(Freshness)({
      _tag: "unavailable",
      pluginHealth: {
        _tag: "disabled",
        checkedAt: "2026-07-13T08:31:00.000Z"
      },
      provenance: {
        _tag: "none",
        pluginConnectionId: PLUGIN_CONNECTION_ID
      },
      sourceObservedAt: null,
      staleAfterSeconds: 900,
      synchronizedAt: null
    })

    expect(Result.isSuccess(missing)).toBe(true)
    expect(Result.isSuccess(unavailable)).toBe(true)
  })

  it("rejects current data whose source observation does not match its revision", () => {
    const result = Schema.decodeUnknownResult(Freshness)({
      _tag: "current",
      pluginHealth: healthy,
      provenance: {
        _tag: "provider",
        sourceRevision
      },
      sourceObservedAt: "2026-07-13T08:29:59.000Z",
      staleAfterSeconds: 900,
      synchronizedAt: "2026-07-13T08:31:00.000Z"
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("rejects freshness timestamps in reverse chronological order", () => {
    const result = Schema.decodeUnknownResult(Freshness)({
      _tag: "stale",
      pluginHealth: healthy,
      provenance: {
        _tag: "cache",
        cachedAt: "2026-07-13T08:20:00.000Z",
        sourceRevision
      },
      sourceObservedAt: sourceRevision.lastObservedAt,
      staleAfterSeconds: 900,
      synchronizedAt: "2026-07-13T08:31:00.000Z"
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("rejects provider provenance for stale data", () => {
    const result = Schema.decodeUnknownResult(Freshness)({
      _tag: "stale",
      pluginHealth: healthy,
      provenance: {
        _tag: "provider",
        sourceRevision
      },
      sourceObservedAt: sourceRevision.lastObservedAt,
      staleAfterSeconds: 900,
      synchronizedAt: "2026-07-13T08:31:00.000Z"
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("rejects healthy plugin state for unavailable data", () => {
    const result = Schema.decodeUnknownResult(Freshness)({
      _tag: "unavailable",
      pluginHealth: healthy,
      provenance: {
        _tag: "none",
        pluginConnectionId: PLUGIN_CONNECTION_ID
      },
      sourceObservedAt: null,
      staleAfterSeconds: 900,
      synchronizedAt: null
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("rejects degraded plugin state for an authoritative missing result", () => {
    const result = Schema.decodeUnknownResult(Freshness)({
      _tag: "missing",
      pluginHealth: {
        _tag: "degraded",
        checkedAt: "2026-07-13T08:31:00.000Z",
        failureClass: "timeout",
        retryAt: "2026-07-13T08:32:00.000Z",
        safeMessage: "Provider request timed out"
      },
      provenance: {
        _tag: "none",
        pluginConnectionId: PLUGIN_CONNECTION_ID
      },
      sourceObservedAt: null,
      staleAfterSeconds: 900,
      synchronizedAt: "2026-07-13T08:31:00.000Z"
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("rejects a plugin retry scheduled before its health check", () => {
    const result = Schema.decodeUnknownResult(Freshness)({
      _tag: "unavailable",
      pluginHealth: {
        _tag: "unavailable",
        checkedAt: "2026-07-13T08:31:00.000Z",
        failureClass: "rate-limit",
        retryAt: "2026-07-13T08:30:59.000Z",
        safeMessage: "Provider rate limit reached"
      },
      provenance: {
        _tag: "none",
        pluginConnectionId: PLUGIN_CONNECTION_ID
      },
      sourceObservedAt: null,
      staleAfterSeconds: 900,
      synchronizedAt: null
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  it("rejects malformed timestamps and non-positive stale thresholds", () => {
    const malformedTimestamp = Schema.decodeUnknownResult(Freshness)({
      _tag: "missing",
      pluginHealth: healthy,
      provenance: {
        _tag: "none",
        pluginConnectionId: PLUGIN_CONNECTION_ID
      },
      sourceObservedAt: null,
      staleAfterSeconds: 900,
      synchronizedAt: "today"
    })
    const nonPositiveThreshold = Schema.decodeUnknownResult(Freshness)({
      _tag: "missing",
      pluginHealth: healthy,
      provenance: {
        _tag: "none",
        pluginConnectionId: PLUGIN_CONNECTION_ID
      },
      sourceObservedAt: null,
      staleAfterSeconds: 0,
      synchronizedAt: "2026-07-13T08:31:00.000Z"
    })

    expect(Result.isFailure(malformedTimestamp)).toBe(true)
    expect(Result.isFailure(nonPositiveThreshold)).toBe(true)
  })
})
