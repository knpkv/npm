import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Result, Schema } from "effect"

import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"

describe("UtcTimestamp", () => {
  it.effect("normalizes an offset instant to canonical UTC", () =>
    Effect.gen(function*() {
      const timestamp = yield* Schema.decodeUnknownEffect(UtcTimestamp)("2026-07-13T12:34:56.789+02:00")
      const encoded = yield* Schema.encodeEffect(UtcTimestamp)(timestamp)

      assert.strictEqual(encoded, "2026-07-13T10:34:56.789Z")
    }))

  it.effect("interprets an unzoned instant as UTC", () =>
    Effect.gen(function*() {
      const timestamp = yield* Schema.decodeUnknownEffect(UtcTimestamp)("2026-07-13T10:34:56.789")

      assert.strictEqual(DateTime.formatIso(timestamp), "2026-07-13T10:34:56.789Z")
    }))

  it("rejects invalid and non-string timestamps", () => {
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(UtcTimestamp)("yesterday")))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(UtcTimestamp)(1_721_000_000)))
  })

  it.effect.prop("round-trips every generated UTC instant", [UtcTimestamp], ([timestamp]) =>
    Effect.gen(function*() {
      const encoded = yield* Schema.encodeEffect(UtcTimestamp)(timestamp)
      const decoded = yield* Schema.decodeUnknownEffect(UtcTimestamp)(encoded)

      assert.strictEqual(DateTime.toEpochMillis(decoded), DateTime.toEpochMillis(timestamp))
      assert.isTrue(encoded.endsWith("Z"))
    }))
})
